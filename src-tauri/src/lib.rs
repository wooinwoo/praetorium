use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder};
use tauri::Manager;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(all(windows, test))]
use windows_sys::Win32::System::JobObjects::{
    JobObjectBasicAccountingInformation, QueryInformationJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, OpenThread, ResumeThread, SetEvent, WaitForSingleObject,
    CREATE_SUSPENDED, INFINITE, THREAD_SUSPEND_RESUME,
};

const SERVER_PORT: u16 = 3848;
const SERVER_START_ATTEMPTS: usize = 3;
const SERVER_START_RETRY_MS: u64 = 500;
const SERVER_START_TIMEOUT_MS: u64 = 8_000;
const SERVER_WATCH_INTERVAL_MS: u64 = 250;
const SERVER_SHUTDOWN_TIMEOUT_MS: u64 = 5_000;
const SERVER_RESTART_ATTEMPTS: usize = 3;
const SERVER_RESTART_BACKOFF_MS: u64 = 500;
const SERVER_RESTART_STABLE_RESET_MS: u64 = 300_000;
const SERVER_LOG_BYTES: u64 = 1_048_576;
const SERVER_LOG_BACKUPS: usize = 3;

const SHUTDOWN_RUNNING: u8 = 0;
const SHUTDOWN_PENDING: u8 = 1;
const SHUTDOWN_COMMITTED: u8 = 2;

#[cfg(windows)]
const DESKTOP_INSTANCE_MUTEX: &str = "Local\\Praetorium.Desktop.Instance.v1";
#[cfg(windows)]
const DESKTOP_FOCUS_EVENT: &str = "Local\\Praetorium.Desktop.Focus.v1";
#[cfg(windows)]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x08000000;

type SharedLog = Arc<Mutex<RotatingLog>>;

#[derive(Clone)]
struct ShutdownState {
    state: Arc<AtomicU8>,
    supervisor_stopped: Arc<(Mutex<bool>, Condvar)>,
}

impl Default for ShutdownState {
    fn default() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(SHUTDOWN_RUNNING)),
            supervisor_stopped: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }
}

impl ShutdownState {
    fn begin(&self) -> bool {
        self.state
            .compare_exchange(
                SHUTDOWN_RUNNING,
                SHUTDOWN_PENDING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn cancel(&self) {
        let _ = self.state.compare_exchange(
            SHUTDOWN_PENDING,
            SHUTDOWN_RUNNING,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    fn commit(&self) -> bool {
        self.state.swap(SHUTDOWN_COMMITTED, Ordering::AcqRel) != SHUTDOWN_COMMITTED
    }

    fn is_running(&self) -> bool {
        self.state.load(Ordering::Acquire) == SHUTDOWN_RUNNING
    }

    fn is_pending(&self) -> bool {
        self.state.load(Ordering::Acquire) == SHUTDOWN_PENDING
    }

    fn is_committed(&self) -> bool {
        self.state.load(Ordering::Acquire) == SHUTDOWN_COMMITTED
    }

    fn mark_supervisor_stopped(&self) {
        let (lock, stopped) = &*self.supervisor_stopped;
        let mut value = lock.lock().unwrap_or_else(|error| error.into_inner());
        *value = true;
        stopped.notify_all();
    }

    fn wait_for_supervisor_stop(&self, timeout: Duration) -> bool {
        let (lock, stopped) = &*self.supervisor_stopped;
        let value = lock.lock().unwrap_or_else(|error| error.into_inner());
        if *value {
            return true;
        }
        let (value, _) = stopped
            .wait_timeout_while(value, timeout, |stopped| !*stopped)
            .unwrap_or_else(|error| error.into_inner());
        *value
    }
}

#[cfg(windows)]
struct OwnedWindowsHandle(usize);

#[cfg(windows)]
impl OwnedWindowsHandle {
    fn new(handle: HANDLE) -> std::io::Result<Self> {
        if handle.is_null() {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(Self(handle as usize))
        }
    }

    fn raw(&self) -> HANDLE {
        self.0 as HANDLE
    }
}

#[cfg(windows)]
impl Drop for OwnedWindowsHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.raw());
        }
    }
}

#[cfg(windows)]
fn wide_name(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
struct DesktopInstanceGuard {
    _mutex: OwnedWindowsHandle,
    focus_event: OwnedWindowsHandle,
}

#[cfg(windows)]
impl DesktopInstanceGuard {
    fn acquire_named(mutex_name: &str, event_name: &str) -> Result<Option<Self>, String> {
        // Create/open the shared event before publishing the mutex. A second process can
        // therefore always signal the primary, even if it arrives during primary startup.
        let event_name = wide_name(event_name);
        let focus_event = unsafe { CreateEventW(std::ptr::null(), 0, 0, event_name.as_ptr()) };
        let focus_event = OwnedWindowsHandle::new(focus_event)
            .map_err(|error| format!("failed to create desktop focus event: {error}"))?;

        let mutex_name = wide_name(mutex_name);
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, mutex_name.as_ptr()) };
        let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let mutex = OwnedWindowsHandle::new(mutex)
            .map_err(|error| format!("failed to create desktop instance mutex: {error}"))?;

        if already_exists {
            unsafe {
                let _ = SetEvent(focus_event.raw());
            }
            return Ok(None);
        }

        Ok(Some(Self {
            _mutex: mutex,
            focus_event,
        }))
    }

    fn wait_for_focus(&self, timeout_ms: u32) -> bool {
        unsafe { WaitForSingleObject(self.focus_event.raw(), timeout_ms) == WAIT_OBJECT_0 }
    }

    fn start_focus_listener(self, app: tauri::AppHandle) -> Result<Option<JoinHandle<()>>, String> {
        thread::Builder::new()
            .name("praetorium-single-instance".to_owned())
            .spawn(move || loop {
                if !self.wait_for_focus(INFINITE) {
                    break;
                }
                show_main_window(&app);
            })
            .map(Some)
            .map_err(|error| format!("failed to start desktop instance listener: {error}"))
    }
}

#[cfg(not(windows))]
struct DesktopInstanceGuard;

#[cfg(not(windows))]
impl DesktopInstanceGuard {
    fn start_focus_listener(
        self,
        _app: tauri::AppHandle,
    ) -> Result<Option<JoinHandle<()>>, String> {
        Ok(None)
    }
}

fn acquire_desktop_instance() -> Result<Option<DesktopInstanceGuard>, String> {
    #[cfg(windows)]
    {
        DesktopInstanceGuard::acquire_named(DESKTOP_INSTANCE_MUTEX, DESKTOP_FOCUS_EVENT)
    }
    #[cfg(not(windows))]
    {
        Ok(Some(DesktopInstanceGuard))
    }
}

#[cfg(windows)]
struct WindowsProcessJob {
    handle: OwnedWindowsHandle,
}

#[cfg(windows)]
impl WindowsProcessJob {
    fn new() -> std::io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        let handle = OwnedWindowsHandle::new(handle)?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle.raw(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { handle })
    }

    fn assign(&self, child: &Child) -> std::io::Result<()> {
        let assigned =
            unsafe { AssignProcessToJobObject(self.handle.raw(), child.as_raw_handle() as HANDLE) };
        if assigned == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn terminate(&self) -> std::io::Result<()> {
        let terminated = unsafe { TerminateJobObject(self.handle.raw(), 1) };
        if terminated == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    fn active_processes(&self) -> std::io::Result<u32> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                self.handle.raw(),
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(accounting.ActiveProcesses)
        }
    }
}

#[cfg(windows)]
fn resume_suspended_process(child: &Child) -> std::io::Result<()> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let snapshot = OwnedWindowsHandle::new(snapshot)?;
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut found = unsafe { Thread32First(snapshot.raw(), &mut entry) } != 0;
    while found {
        if entry.th32OwnerProcessID == child.id() {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            let thread = OwnedWindowsHandle::new(thread)?;
            if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
                return Err(std::io::Error::last_os_error());
            }
            return Ok(());
        }
        found = unsafe { Thread32Next(snapshot.raw(), &mut entry) } != 0;
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "suspended Node.js primary thread was not found",
    ))
}

struct ServerProcess {
    child: Child,
    #[cfg(windows)]
    job: WindowsProcessJob,
}

impl ServerProcess {
    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    fn terminate_remaining_tree(&self) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            self.job.terminate()
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }

    fn terminate_tree(&mut self) -> std::io::Result<()> {
        #[cfg(windows)]
        let result = self.job.terminate();
        #[cfg(not(windows))]
        let result = self.child.kill();
        let _ = self.child.wait();
        result
    }
}

struct RotatingLog {
    path: PathBuf,
    max_bytes: u64,
    backups: usize,
}

impl RotatingLog {
    fn new(path: PathBuf, max_bytes: u64, backups: usize) -> Self {
        let logger = Self {
            path,
            max_bytes: max_bytes.max(1),
            backups,
        };
        let _ = logger.prepare();
        logger
    }

    fn prepare(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        self.trim_to_limit(&self.path)?;
        for index in 1..=self.backups {
            self.trim_to_limit(&self.backup_path(index))?;
        }
        Ok(())
    }

    fn trim_to_limit(&self, path: &Path) -> std::io::Result<()> {
        let length = match fs::metadata(path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if length <= self.max_bytes {
            return Ok(());
        }

        let mut source = File::open(path)?;
        source.seek(SeekFrom::End(-(self.max_bytes as i64)))?;
        let mut tail = Vec::with_capacity(self.max_bytes as usize);
        source.read_to_end(&mut tail)?;
        let mut destination = OpenOptions::new().write(true).truncate(true).open(path)?;
        destination.write_all(&tail)
    }

    fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.prepare()?;
        let bytes = if bytes.len() as u64 > self.max_bytes {
            &bytes[bytes.len() - self.max_bytes as usize..]
        } else {
            bytes
        };
        let current_length = fs::metadata(&self.path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current_length.saturating_add(bytes.len() as u64) > self.max_bytes {
            self.rotate()?;
        }

        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(bytes)
    }

    fn rotate(&self) -> std::io::Result<()> {
        if self.backups == 0 {
            return match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            };
        }

        for index in (1..=self.backups).rev() {
            let source = if index == 1 {
                self.path.clone()
            } else {
                self.backup_path(index - 1)
            };
            let destination = self.backup_path(index);
            match fs::remove_file(&destination) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            match fs::rename(&source, &destination) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn backup_path(&self, index: usize) -> PathBuf {
        let mut path = self.path.as_os_str().to_os_string();
        path.push(format!(".{index}"));
        PathBuf::from(path)
    }
}

fn data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("LOCALAPPDATA").filter(|path| !path.is_empty()) {
        return PathBuf::from(path).join("PraetoriumData");
    }
    if let Some(path) = std::env::var_os("APPDATA").filter(|path| !path.is_empty()) {
        return PathBuf::from(path).join("PraetoriumData");
    }
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|path| !path.is_empty())
    {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("PraetoriumData");
    }

    std::env::temp_dir().join("PraetoriumData")
}

fn write_log(log: &SharedLog, source: &str, bytes: &[u8]) {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let mut record = format!(
        "[{}.{:03}] [{source}] ",
        elapsed.as_secs(),
        elapsed.subsec_millis()
    )
    .into_bytes();
    record.extend_from_slice(bytes);
    if !record.ends_with(b"\n") {
        record.push(b'\n');
    }
    if let Ok(mut logger) = log.lock() {
        let _ = logger.append(&record);
    }
}

fn capture_pipe(mut pipe: impl Read + Send + 'static, source: &'static str, log: SharedLog) {
    let _ = thread::Builder::new()
        .name(format!("praetorium-server-{source}"))
        .spawn(move || {
            let mut buffer = [0_u8; 8_192];
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => write_log(&log, source, &buffer[..length]),
                    Err(error) => {
                        write_log(
                            &log,
                            "supervisor",
                            format!("failed reading server {source}: {error}").as_bytes(),
                        );
                        break;
                    }
                }
            }
        });
}

fn spawn_server(server_dir: &Path, log: &SharedLog) -> Result<ServerProcess, String> {
    #[cfg(windows)]
    let job = WindowsProcessJob::new()
        .map_err(|error| format!("failed to create Node.js process job: {error}"))?;
    let mut command = Command::new("node");
    command
        .args(["server.js", "--no-open"])
        .current_dir(server_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(WINDOWS_CREATE_NO_WINDOW | CREATE_SUSPENDED);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn Node.js: {error}"))?;
    #[cfg(windows)]
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "failed to contain Node.js in a Windows Job Object: {error}"
        ));
    }
    if let Some(stdout) = child.stdout.take() {
        capture_pipe(stdout, "stdout", Arc::clone(log));
    }
    if let Some(stderr) = child.stderr.take() {
        capture_pipe(stderr, "stderr", Arc::clone(log));
    }
    #[cfg(windows)]
    if let Err(error) = resume_suspended_process(&child) {
        let _ = job.terminate();
        let _ = child.wait();
        return Err(format!(
            "failed to resume contained Node.js process: {error}"
        ));
    }
    write_log(
        log,
        "supervisor",
        format!("started Node.js server process pid={}", child.id()).as_bytes(),
    );
    Ok(ServerProcess {
        child,
        #[cfg(windows)]
        job,
    })
}

fn start_server(server_dir: &Path, log: &SharedLog) -> Result<ServerProcess, String> {
    for attempt in 1..=SERVER_START_ATTEMPTS {
        match spawn_server(server_dir, log) {
            Ok(child) => return Ok(child),
            Err(error) if attempt < SERVER_START_ATTEMPTS => {
                write_log(
                    log,
                    "supervisor",
                    format!(
                        "server start attempt {attempt}/{SERVER_START_ATTEMPTS} failed: {error}"
                    )
                    .as_bytes(),
                );
                thread::sleep(Duration::from_millis(SERVER_START_RETRY_MS));
            }
            Err(error) => {
                return Err(format!(
                    "failed to start server after {SERVER_START_ATTEMPTS} attempts: {error}"
                ));
            }
        }
    }
    unreachable!()
}

fn http_response_is_complete(response: &str) -> bool {
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let Some(content_length) = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())?
    }) else {
        return false;
    };
    body.len() >= content_length
}

fn server_request(port: u16, method: &str, path: &str) -> Option<String> {
    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).ok()?;
    let timeout = Some(Duration::from_secs(3));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    match stream.read_to_string(&mut response) {
        Ok(_) if http_response_is_complete(&response) => Some(response),
        Err(error)
            if http_response_is_complete(&response)
                && matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
        {
            Some(response)
        }
        _ => None,
    }
}

fn server_matches_version(port: u16, version: &str) -> bool {
    server_request(port, "GET", "/api/health")
        .map(|response| {
            response.starts_with("HTTP/1.1 200")
                && response.contains("\"status\":\"ok\"")
                && response.contains(&format!("\"version\":\"{version}\""))
        })
        .unwrap_or(false)
}

fn wait_for_server(port: u16, version: &str, timeout_ms: u64) -> bool {
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    while start.elapsed() < timeout {
        if server_matches_version(port, version) {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

fn request_server_shutdown(port: u16) -> bool {
    server_request(port, "POST", "/api/system/shutdown")
        .map(|response| response.starts_with("HTTP/1.1 202"))
        .unwrap_or(false)
}

fn restart_backoff(attempt: usize) -> Duration {
    let exponent = attempt.saturating_sub(1).min(10) as u32;
    Duration::from_millis(SERVER_RESTART_BACKOFF_MS.saturating_mul(1_u64 << exponent))
}

fn should_reset_restart_budget(stable_for: Duration) -> bool {
    stable_for >= Duration::from_millis(SERVER_RESTART_STABLE_RESET_MS)
}

fn wait_for_restart(state: &ShutdownState, delay: Duration) -> bool {
    let deadline = Instant::now() + delay;
    loop {
        if state.is_committed() {
            return false;
        }
        if state.is_pending() {
            thread::sleep(Duration::from_millis(SERVER_WATCH_INTERVAL_MS));
            continue;
        }
        if Instant::now() >= deadline {
            return true;
        }
        thread::sleep(
            Duration::from_millis(SERVER_WATCH_INTERVAL_MS)
                .min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

enum ReplacementState {
    Ready,
    Failed(String),
    Shutdown,
}

fn wait_for_replacement(
    child: &mut ServerProcess,
    version: &str,
    shutdown: &ShutdownState,
) -> ReplacementState {
    let start = Instant::now();
    let timeout = Duration::from_millis(SERVER_START_TIMEOUT_MS);
    while start.elapsed() < timeout {
        if shutdown.is_committed() {
            return ReplacementState::Shutdown;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return ReplacementState::Failed(format!(
                    "replacement process exited before becoming ready: {status}"
                ));
            }
            Ok(None) => {}
            Err(error) => {
                return ReplacementState::Failed(format!(
                    "could not inspect replacement process: {error}"
                ));
            }
        }
        if server_matches_version(SERVER_PORT, version) {
            return ReplacementState::Ready;
        }
        thread::sleep(Duration::from_millis(200));
    }
    ReplacementState::Failed(format!(
        "replacement did not report version {version} within {SERVER_START_TIMEOUT_MS}ms"
    ))
}

fn stop_child(child: &mut ServerProcess) {
    let _ = child.terminate_tree();
}

fn finish_committed_shutdown(child: &mut ServerProcess, log: &SharedLog) {
    let deadline = Instant::now() + Duration::from_millis(SERVER_SHUTDOWN_TIMEOUT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = child.terminate_remaining_tree();
                write_log(
                    log,
                    "supervisor",
                    format!("Node.js server completed graceful shutdown: {status}").as_bytes(),
                );
                return;
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(SERVER_WATCH_INTERVAL_MS));
            }
            Ok(None) => {
                write_log(
                    log,
                    "supervisor",
                    b"graceful server shutdown timed out; terminating contained process tree",
                );
                stop_child(child);
                return;
            }
            Err(error) => {
                write_log(
                    log,
                    "supervisor",
                    format!("could not inspect server during shutdown: {error}").as_bytes(),
                );
                stop_child(child);
                return;
            }
        }
    }
}

fn supervise_server(
    child: ServerProcess,
    server_dir: PathBuf,
    version: String,
    shutdown: ShutdownState,
    log: SharedLog,
    app: tauri::AppHandle,
) {
    struct StopNotifier(ShutdownState);
    impl Drop for StopNotifier {
        fn drop(&mut self) {
            self.0.mark_supervisor_stopped();
        }
    }

    let _notifier = StopNotifier(shutdown.clone());
    supervise_server_inner(child, server_dir, version, shutdown, log, app);
}

fn supervise_server_inner(
    mut child: ServerProcess,
    server_dir: PathBuf,
    version: String,
    shutdown: ShutdownState,
    log: SharedLog,
    app: tauri::AppHandle,
) {
    let mut restart_attempts = 0;
    let mut healthy_since = Instant::now();
    loop {
        if shutdown.is_committed() {
            finish_committed_shutdown(&mut child, &log);
            return;
        }

        match child.try_wait() {
            Ok(None) => {
                thread::sleep(Duration::from_millis(SERVER_WATCH_INTERVAL_MS));
                continue;
            }
            Ok(Some(status)) => {
                write_log(
                    &log,
                    "supervisor",
                    format!("Node.js server process exited: {status}").as_bytes(),
                );
                if let Err(error) = child.terminate_remaining_tree() {
                    write_log(
                        &log,
                        "supervisor",
                        format!("failed to terminate exited server process tree: {error}")
                            .as_bytes(),
                    );
                }
            }
            Err(error) => {
                write_log(
                    &log,
                    "supervisor",
                    format!("watchdog could not inspect Node.js server process: {error}")
                        .as_bytes(),
                );
                return;
            }
        }

        if restart_attempts > 0 && should_reset_restart_budget(healthy_since.elapsed()) {
            restart_attempts = 0;
            write_log(
                &log,
                "supervisor",
                b"server was stable for five minutes; restart budget reset",
            );
        }

        while shutdown.is_pending() {
            thread::sleep(Duration::from_millis(SERVER_WATCH_INTERVAL_MS));
        }
        if !shutdown.is_running() {
            write_log(
                &log,
                "supervisor",
                b"server exited during intentional shutdown; restart suppressed",
            );
            return;
        }

        loop {
            if restart_attempts >= SERVER_RESTART_ATTEMPTS {
                write_log(
                    &log,
                    "supervisor",
                    format!("restart budget exhausted after {SERVER_RESTART_ATTEMPTS} attempts")
                        .as_bytes(),
                );
                return;
            }
            restart_attempts += 1;
            let delay = restart_backoff(restart_attempts);
            write_log(
                &log,
                "supervisor",
                format!(
                    "scheduling restart attempt {restart_attempts}/{SERVER_RESTART_ATTEMPTS} after {}ms",
                    delay.as_millis()
                )
                .as_bytes(),
            );
            if !wait_for_restart(&shutdown, delay) {
                write_log(
                    &log,
                    "supervisor",
                    b"intentional shutdown committed; pending restart cancelled",
                );
                return;
            }

            if server_matches_version(SERVER_PORT, &version) {
                write_log(
                    &log,
                    "supervisor",
                    b"server ownership was lost to another matching process; desktop exiting",
                );
                shutdown.commit();
                app.exit(1);
                return;
            }
            if TcpStream::connect(("127.0.0.1", SERVER_PORT)).is_ok() {
                write_log(
                    &log,
                    "supervisor",
                    b"server ownership was lost to another service on port 3848; desktop exiting",
                );
                shutdown.commit();
                app.exit(1);
                return;
            }

            let mut replacement = match spawn_server(&server_dir, &log) {
                Ok(child) => child,
                Err(error) => {
                    write_log(
                        &log,
                        "supervisor",
                        format!("restart attempt {restart_attempts} failed: {error}").as_bytes(),
                    );
                    continue;
                }
            };
            match wait_for_replacement(&mut replacement, &version, &shutdown) {
                ReplacementState::Ready => {
                    write_log(
                        &log,
                        "supervisor",
                        format!("restart attempt {restart_attempts} became healthy").as_bytes(),
                    );
                    child = replacement;
                    healthy_since = Instant::now();
                    break;
                }
                ReplacementState::Failed(error) => {
                    write_log(&log, "supervisor", error.as_bytes());
                    stop_child(&mut replacement);
                }
                ReplacementState::Shutdown => {
                    stop_child(&mut replacement);
                    write_log(
                        &log,
                        "supervisor",
                        b"intentional shutdown committed while replacement was starting",
                    );
                    return;
                }
            }
        }
    }
}

fn start_watchdog(
    child: ServerProcess,
    server_dir: PathBuf,
    version: &str,
    shutdown: ShutdownState,
    log: SharedLog,
    app: tauri::AppHandle,
) -> Result<JoinHandle<()>, String> {
    let version = version.to_owned();
    thread::Builder::new()
        .name("praetorium-server-watchdog".to_owned())
        .spawn(move || supervise_server(child, server_dir, version, shutdown, log, app))
        .map_err(|error| format!("failed to start server watchdog: {error}"))
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let instance_guard = match acquire_desktop_instance()
        .expect("Failed to enforce the Praetorium desktop single-instance boundary")
    {
        Some(guard) => guard,
        None => return,
    };

    let context = tauri::generate_context!();
    let server_dir = if cfg!(debug_assertions) {
        std::env::current_dir()
            .expect("Failed to resolve current directory")
            .parent()
            .expect("Tauri development directory has no parent")
            .to_path_buf()
    } else {
        tauri::utils::platform::resource_dir(
            context.package_info(),
            &tauri::utils::Env::default(),
        )
        .expect("Failed to resolve packaged resource directory")
    };

    let version = env!("CARGO_PKG_VERSION");
    if server_matches_version(SERVER_PORT, version) {
        panic!(
            "A matching Praetorium server is already running without this desktop's process ownership. Stop it safely before starting Praetorium."
        );
    }
    if TcpStream::connect(("127.0.0.1", SERVER_PORT)).is_ok() {
        panic!(
            "Port 3848 is owned by a different or outdated service. Stop it safely before starting Praetorium."
        );
    }

    let log = Arc::new(Mutex::new(RotatingLog::new(
        data_dir().join("logs").join("server.log"),
        SERVER_LOG_BYTES,
        SERVER_LOG_BACKUPS,
    )));
    write_log(
        &log,
        "supervisor",
        format!("Praetorium desktop starting version={version}").as_bytes(),
    );
    let mut server_process = start_server(&server_dir, &log)
        .expect("Failed to start node server. Is Node.js installed?");
    if !wait_for_server(SERVER_PORT, version, SERVER_START_TIMEOUT_MS) {
        stop_child(&mut server_process);
        panic!("Praetorium server did not report the packaged version within 8 seconds");
    }

    let shutdown = ShutdownState::default();
    let menu_shutdown = shutdown.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Praetorium", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let quit_shutdown = menu_shutdown.clone();

            let mut builder = TrayIconBuilder::new()
                .tooltip("Praetorium")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => {
                        if !quit_shutdown.begin() {
                            return;
                        }
                        if request_server_shutdown(SERVER_PORT) {
                            quit_shutdown.commit();
                            let _ = quit_shutdown.wait_for_supervisor_stop(Duration::from_millis(
                                SERVER_SHUTDOWN_TIMEOUT_MS + SERVER_WATCH_INTERVAL_MS * 2,
                            ));
                            app.exit(0);
                        } else if quit_shutdown.wait_for_supervisor_stop(Duration::ZERO) {
                            quit_shutdown.commit();
                            app.exit(0);
                        } else {
                            quit_shutdown.cancel();
                            show_main_window(app);
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }

            builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(context)
        .expect("error while building tauri application");

    let _watchdog = start_watchdog(
        server_process,
        server_dir,
        version,
        shutdown.clone(),
        Arc::clone(&log),
        app.handle().clone(),
    )
    .expect("Failed to start Node.js server watchdog");
    let _instance_listener = instance_guard
        .start_focus_listener(app.handle().clone())
        .expect("Failed to start the Praetorium desktop single-instance listener");

    app.run(move |app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if shutdown.is_committed() {
                return;
            }
            if !shutdown.begin() {
                api.prevent_exit();
                return;
            }
            if request_server_shutdown(SERVER_PORT) {
                shutdown.commit();
                let _ = shutdown.wait_for_supervisor_stop(Duration::from_millis(
                    SERVER_SHUTDOWN_TIMEOUT_MS + SERVER_WATCH_INTERVAL_MS * 2,
                ));
            } else if shutdown.wait_for_supervisor_stop(Duration::ZERO) {
                shutdown.commit();
            } else {
                shutdown.cancel();
                api.prevent_exit();
                show_main_window(app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "praetorium-rust-test-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn rotating_log_bounds_current_and_backups() {
        let directory = temporary_directory("rotation");
        let path = directory.join("server.log");
        let mut log = RotatingLog::new(path.clone(), 64, 2);

        for index in 0..20 {
            log.append(format!("record-{index:02}-abcdefghij\n").as_bytes())
                .unwrap();
        }

        for candidate in [&path, &log.backup_path(1), &log.backup_path(2)] {
            let length = fs::metadata(candidate).unwrap().len();
            assert!(length <= 64, "{} was {length} bytes", candidate.display());
        }
        assert!(!log.backup_path(3).exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rotating_log_keeps_only_tail_of_oversized_record() {
        let directory = temporary_directory("oversized");
        let path = directory.join("server.log");
        let mut log = RotatingLog::new(path.clone(), 8, 1);

        log.append(b"0123456789abcdef").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"89abcdef");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn shutdown_can_be_cancelled_before_commit() {
        let shutdown = ShutdownState::default();
        assert!(shutdown.begin());
        assert!(shutdown.is_pending());
        shutdown.cancel();
        assert!(shutdown.is_running());
        assert!(shutdown.commit());
        assert!(shutdown.is_committed());
        assert!(!shutdown.commit());
    }

    #[test]
    fn committed_shutdown_cancels_restart_wait() {
        let shutdown = ShutdownState::default();
        shutdown.commit();
        let start = Instant::now();

        assert!(!wait_for_restart(&shutdown, Duration::from_secs(2)));
        assert!(start.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn pending_shutdown_suppresses_restart_until_committed() {
        let shutdown = ShutdownState::default();
        assert!(shutdown.begin());
        let waiting_state = shutdown.clone();
        let waiter = thread::spawn(move || wait_for_restart(&waiting_state, Duration::ZERO));

        thread::sleep(Duration::from_millis(25));
        assert!(!waiter.is_finished());
        shutdown.commit();
        assert!(!waiter.join().unwrap());
    }

    #[test]
    fn graceful_shutdown_waits_for_the_watchdog_to_release_process_ownership() {
        let shutdown = ShutdownState::default();
        assert!(!shutdown.wait_for_supervisor_stop(Duration::ZERO));
        let notifier = shutdown.clone();
        let worker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            notifier.mark_supervisor_stopped();
        });

        assert!(shutdown.wait_for_supervisor_stop(Duration::from_secs(1)));
        worker.join().unwrap();
    }

    #[test]
    fn server_request_keeps_a_received_response_when_the_peer_stays_open() {
        use std::net::TcpListener;
        use std::sync::mpsc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (release_tx, release_rx) = mpsc::channel();
        let peer = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}")
                .unwrap();
            stream.flush().unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        });

        let response = server_request(port, "POST", "/api/system/shutdown");
        release_tx.send(()).unwrap();
        peer.join().unwrap();

        assert!(response.unwrap().starts_with("HTTP/1.1 202"));
    }

    #[test]
    fn server_request_rejects_a_truncated_http_body() {
        assert!(!http_response_is_complete(
            "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"status\":\"ok\",\"version\":\"2.3.0\""
        ));
    }

    #[cfg(windows)]
    #[test]
    fn second_desktop_instance_signals_the_primary_focus_event() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mutex = format!(
            "Local\\Praetorium.Test.Instance.{}.{}",
            std::process::id(),
            unique
        );
        let event = format!(
            "Local\\Praetorium.Test.Focus.{}.{}",
            std::process::id(),
            unique
        );

        let primary = DesktopInstanceGuard::acquire_named(&mutex, &event)
            .unwrap()
            .expect("the first instance must own the mutex");
        assert!(DesktopInstanceGuard::acquire_named(&mutex, &event)
            .unwrap()
            .is_none());
        assert!(primary.wait_for_focus(1_000));

        drop(primary);
        assert!(DesktopInstanceGuard::acquire_named(&mutex, &event)
            .unwrap()
            .is_some());
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_contains_and_terminates_node_descendants() {
        let job = WindowsProcessJob::new().unwrap();
        let mut child = Command::new("node")
            .args([
                "-e",
                "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setInterval(()=>{},1000);",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(WINDOWS_CREATE_NO_WINDOW | CREATE_SUSPENDED)
            .spawn()
            .unwrap();
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("failed to assign test process to job: {error}");
        }
        if let Err(error) = resume_suspended_process(&child) {
            let _ = job.terminate();
            let _ = child.wait();
            panic!("failed to resume contained test process: {error}");
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut contained_descendant = false;
        while Instant::now() < deadline {
            if job.active_processes().unwrap() >= 2 {
                contained_descendant = true;
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }

        job.terminate().unwrap();
        let _ = child.wait();
        let drained_deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < drained_deadline && job.active_processes().unwrap() != 0 {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            contained_descendant,
            "the Node grandchild escaped the Job Object"
        );
        assert_eq!(job.active_processes().unwrap(), 0);
    }

    #[test]
    fn restart_backoff_is_bounded_and_exponential() {
        assert_eq!(restart_backoff(1), Duration::from_millis(500));
        assert_eq!(restart_backoff(2), Duration::from_millis(1_000));
        assert_eq!(restart_backoff(3), Duration::from_millis(2_000));
    }

    #[test]
    fn restart_budget_resets_only_after_stable_interval() {
        assert!(!should_reset_restart_budget(Duration::from_millis(
            SERVER_RESTART_STABLE_RESET_MS - 1
        )));
        assert!(should_reset_restart_budget(Duration::from_millis(
            SERVER_RESTART_STABLE_RESET_MS
        )));
    }
}
