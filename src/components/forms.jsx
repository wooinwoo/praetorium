import { useActionState, useEffect, useId, useOptimistic, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { api } from '../lib/api.js';
import { interventionReceiptText, ownerDecisionPayload } from '../domain/operator-model.js';
import { readImageBase64, validateImageSelection } from '../lib/image-attachments.js';
import { formatClock, Icon, RichText } from './common.jsx';

function revokePreview(item) {
  if (String(item?.previewUrl || '').startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
}

function SubmitButton({ children, icon = 'send', className = 'primary-button', disabled = false }) {
  const { pending } = useFormStatus();
  return <button type="submit" className={className} disabled={pending || disabled}>{pending ? <span className="spinner" /> : <Icon name={icon} />}{pending ? '처리 중' : children}</button>;
}

export function DirectorComposer({ directorId, goalId = null, defaultMode = 'auto', onAccepted, messages, readOnly = false, readOnlyAction = null, hasOlder = false, loadingOlder = false, onLoadOlder, historyError = '' }) {
  const formRef = useRef(null);
  const chatRef = useRef(null);
  const fileInputRef = useRef(null);
  const attachmentsRef = useRef([]);
  const mountedRef = useRef(true);
  const readingImagesRef = useRef(false);
  const submittingRef = useRef(false);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState(defaultMode);
  const [follow, setFollow] = useState(true);
  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [readingImages, setReadingImages] = useState(false);
  const [draggingImages, setDraggingImages] = useState(false);
  const [expandedImage, setExpandedImage] = useState(null);
  attachmentsRef.current = attachments;
  const clearAttachments = () => {
    attachmentsRef.current.forEach(revokePreview);
    attachmentsRef.current = [];
    setAttachments([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const addImages = async files => {
    if (actionPending || readingImagesRef.current || submittingRef.current) return;
    readingImagesRef.current = true;
    const validation = validateImageSelection(files, attachmentsRef.current);
    if (!validation.ok) {
      readingImagesRef.current = false;
      setAttachmentError(validation.error);
      return;
    }
    setReadingImages(true);
    setAttachmentError('');
    let prepared = [];
    try {
      const encoded = await Promise.all(validation.files.map(file => readImageBase64(file)));
      if (!mountedRef.current) return;
      prepared = validation.files.map((file, index) => ({
        id: `${Date.now()}:${globalThis.crypto?.randomUUID?.() || Math.random()}`,
        name: file.name || 'image', mimeType: file.type, size: file.size,
        dataBase64: encoded[index], previewUrl: `data:${file.type};base64,${encoded[index]}`,
      }));
      setAttachments(current => {
        const next = [...current, ...prepared];
        attachmentsRef.current = next;
        return next;
      });
    } catch (error) {
      prepared.forEach(revokePreview);
      if (mountedRef.current) setAttachmentError(error.message);
    }
    finally {
      readingImagesRef.current = false;
      if (mountedRef.current) {
        setReadingImages(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };
  const [optimisticMessages, addOptimistic] = useOptimistic(messages, (current, message) => [...current, message]);
  const [result, action, actionPending] = useActionState(async (_previous, formData) => {
    const typedPrompt = String(formData.get('prompt') || '').trim();
    const submittedAttachments = [...attachmentsRef.current];
    const prompt = typedPrompt || (submittedAttachments.length ? '첨부한 이미지를 확인하고 요청에 필요한 내용을 판단해 주세요.' : '');
    const mode = String(formData.get('mode') || 'auto');
    if (!prompt) {
      submittingRef.current = false;
      return { error: '요청을 입력하세요.' };
    }
    const pendingId = `pending-${Date.now()}`;
    setFollow(true);
    addOptimistic({ id: pendingId, role: 'owner', text: prompt, attachments: submittedAttachments, at: new Date().toISOString(), pending: true });
    try {
      const endpoint = goalId
        ? `/api/directors/${encodeURIComponent(directorId)}/goals/${encodeURIComponent(goalId)}/guidance`
        : `/api/directors/${encodeURIComponent(directorId)}/messages`;
      const accepted = await api(endpoint, {
        method: 'POST', body: {
          ...(goalId ? { message: prompt } : { prompt, mode }),
          attachments: submittedAttachments.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 })),
        },
      });
      await onAccepted?.(accepted);
      if (mountedRef.current) {
        setDraft('');
        clearAttachments();
      }
      return { ok: true, accepted };
    } catch (error) {
      return { error: error.message };
    } finally {
      submittingRef.current = false;
    }
  }, null);
  const latestMessage = optimisticMessages.at(-1);
  const guidanceErrors = goalId && result?.ok && Array.isArray(result.accepted?.errors) ? result.accepted.errors : [];
  const guidanceReceipts = goalId && result?.ok && Array.isArray(result.accepted?.receipts) ? result.accepted.receipts : [];

  useEffect(() => {
    if (follow && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [latestMessage?.id, latestMessage?.text, latestMessage?.pending, follow]);
  useEffect(() => {
    if (!expandedImage) return undefined;
    const closeOnEscape = event => { if (event.key === 'Escape') setExpandedImage(null); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [expandedImage]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attachmentsRef.current.forEach(revokePreview);
    };
  }, []);

  return <div className="director-thread-layout">
    <div ref={chatRef} className="chat-stream" role="log" aria-live="polite" onScroll={event => setFollow(event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 48)}>
      {hasOlder && <button type="button" className="load-older chat-load-older" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder ? '이전 대화 불러오는 중…' : '이전 대화 불러오기'}</button>}
      {historyError && <p className="chat-history-error" role="alert">이전 대화를 불러오지 못했습니다. 다시 시도해 주세요.</p>}
      {!optimisticMessages.length && <div className="thread-empty"><strong>디렉터와 대화를 시작하세요.</strong><span>빠른 답변, 자율 판단, Worker 위임을 디렉터가 선택할 수 있습니다.</span></div>}
      {optimisticMessages.map(message => <article key={message.id} className={`chat-message ${message.role} ${message.pending ? 'pending' : ''}`}>
        <span className="chat-avatar">{message.role === 'owner' ? '나' : 'D'}</span>
        <div>
          <header><strong>{message.role === 'owner' ? '나' : '디렉터'}</strong><time>{formatClock(message.at)}</time>{message.kind && <em>{message.kind}</em>}</header>
          <div className="chat-copy"><RichText>{message.text}</RichText>{!!message.attachments?.length && <div className="chat-attachments">{message.attachments.map((attachment, index) => attachment.previewUrl ? <button type="button" className="chat-image-preview" key={attachment.id || `${attachment.name}:${index}`} onClick={() => setExpandedImage(attachment)} aria-label={`${attachment.name || `첨부 이미지 ${index + 1}`} 크게 보기`}><img src={attachment.previewUrl} alt={attachment.name || `첨부 이미지 ${index + 1}`} /></button> : <span key={attachment.id || `${attachment.name}:${index}`}><Icon name="image" />{attachment.name || `첨부 이미지 ${index + 1}`}</span>)}</div>}</div>
          {message.pending && <small>전송 중…</small>}
        </div>
      </article>)}
    </div>
    {readOnly ? <div className="goal-thread-footer"><span>이 기록은 현재 Goal에 한정됩니다.</span>{readOnlyAction}</div> : <form ref={formRef} action={action} aria-busy={actionPending || readingImages} className={`director-composer ${draggingImages ? 'dragging-images' : ''}`} onSubmit={event => {
      if (actionPending || submittingRef.current) event.preventDefault();
      else submittingRef.current = true;
    }} onDragEnter={event => { event.preventDefault(); if (!actionPending && !readingImages) setDraggingImages(true); }} onDragOver={event => event.preventDefault()} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDraggingImages(false); }} onDrop={event => { event.preventDefault(); setDraggingImages(false); if (!actionPending) void addImages(event.dataTransfer.files); }} onKeyDown={event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !actionPending && !submittingRef.current) event.currentTarget.requestSubmit();
    }}>
      <label className="sr-only" htmlFor="director-prompt">디렉터에게 요청</label>
      <textarea id="director-prompt" name="prompt" rows="2" value={draft} disabled={actionPending} onChange={event => setDraft(event.target.value)} onPaste={event => { if (actionPending || readingImages) return; const images = [...event.clipboardData.files].filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void addImages(images); } }} placeholder={goalId ? '현재 Goal의 방향 수정, 추가 조건이나 이미지를 전달하세요.' : '요청을 입력하거나 이미지를 붙여넣으세요. 디렉터가 답변·조사·Worker 위임을 판단합니다.'} />
      {!!attachments.length && <div className="composer-attachments" aria-label="첨부 이미지">{attachments.map(attachment => <figure key={attachment.id}><button type="button" className="composer-preview-open" disabled={actionPending} onClick={() => setExpandedImage(attachment)} aria-label={`${attachment.name} 크게 보기`}><img src={attachment.previewUrl} alt="" /></button><figcaption title={attachment.name}>{attachment.name}</figcaption><button type="button" className="composer-preview-remove" disabled={actionPending} aria-label={`${attachment.name} 제거`} onClick={() => { revokePreview(attachment); setAttachments(current => { const next = current.filter(item => item.id !== attachment.id); attachmentsRef.current = next; return next; }); }}><Icon name="x" /></button></figure>)}</div>}
      <footer>
        <input ref={fileInputRef} className="sr-only" type="file" tabIndex="-1" aria-label="첨부할 이미지 선택" disabled={actionPending || readingImages} accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={event => void addImages(event.target.files)} />
        <button type="button" className="composer-attach" disabled={actionPending || readingImages || attachments.length >= 4} onClick={() => fileInputRef.current?.click()} aria-label="이미지 첨부"><Icon name="image" />{readingImages ? '읽는 중' : '이미지'}</button>
        {goalId ? <span className="goal-guidance-mode"><Icon name="branch" />현재 Goal 수정</span> : <label><span className="sr-only">처리 방식</span><select name="mode" value={mode} disabled={actionPending} onChange={event => setMode(event.target.value)}>
          <option value="auto">자동</option>
          <option value="delegate">Worker 위임</option>
          <option value="conversation">답변만</option>
        </select></label>}
        <span className="composer-hint">Ctrl+Enter로 전송</span>
        <SubmitButton disabled={actionPending || readingImages || (!draft.trim() && !attachments.length)}>보내기</SubmitButton>
      </footer>
      {draggingImages && <div className="image-drop-overlay"><Icon name="image" /><strong>이미지를 여기에 놓으세요</strong><small>PNG · JPEG · WebP · GIF</small></div>}
      {attachmentError && <p className="form-error" role="alert">{attachmentError}</p>}
      {result?.error && <p className="form-error" role="alert">{result.error}</p>}
      {goalId && result?.ok && !guidanceErrors.length && <p className="form-success" role="status">Goal 지시 저장됨 · {guidanceReceipts.length ? `Worker ${guidanceReceipts.length}개 전달 접수 · 확인 대기` : '다음 Director 판단에 반영'}</p>}
      {!!guidanceErrors.length && <p className="form-warning" role="status" title={guidanceErrors.map(item => `${item.taskId || 'Worker'}: ${item.error || '전달 실패'}`).join('\n')}>Goal 지시는 저장됐지만 Worker {guidanceErrors.length}개에는 즉시 전달되지 않았습니다. Goal 기록은 유지됩니다. Worker 상세에서 수신 상태를 확인한 뒤 필요한 작업에 직접 지시하세요.</p>}
    </form>}
    {expandedImage && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`${expandedImage.name || '첨부 이미지'} 크게 보기`} onMouseDown={event => { if (event.target === event.currentTarget) setExpandedImage(null); }}>
      <figure><button type="button" className="image-lightbox-close" autoFocus onClick={() => setExpandedImage(null)} aria-label="크게 보기 닫기"><Icon name="x" /></button><img src={expandedImage.previewUrl} alt={expandedImage.name || '첨부 이미지'} /><figcaption>{expandedImage.name || '첨부 이미지'}</figcaption></figure>
    </div>}
  </div>;
}

const effectLabels = {
  read_only: '읽기 전용',
  workspace_write: '프로젝트 쓰기',
  external_mutation: '외부 변경',
  skill_activation: '스킬 활성화',
};

export function AuthorityDecisionDetails({ decision }) {
  const fallbackAction = decision?.effect || decision?.target || decision?.writeScope
    ? [{ id: 'authority-action', title: decision?.title || '승인 대상 작업', effect: decision.effect, target: decision.target, writeScope: decision.writeScope }]
    : [];
  const actions = decision?.plannedActions?.length ? decision.plannedActions : fallbackAction;
  const hasAuthority = Boolean(decision?.approvalKind || decision?.planDigest || decision?.candidateDigest
    || (decision?.throughWave !== null && decision?.throughWave !== undefined) || actions.length);
  if (!hasAuthority) return null;
  return <section className="authority-decision" aria-label="승인 권한과 적용 범위">
    <header><span><Icon name="layers" /><strong>승인 권한과 적용 범위</strong></span><small>아래 범위에만 승인됩니다.</small></header>
    <dl className="authority-metadata">
      {decision.approvalKind && <div><dt>승인 종류</dt><dd><code>{decision.approvalKind}</code></dd></div>}
      {decision.throughWave !== null && decision.throughWave !== undefined && <div><dt>적용 Wave</dt><dd>Wave {decision.throughWave}까지</dd></div>}
      {decision.planDigest && <div><dt>Plan digest</dt><dd><code title={decision.planDigest}>{decision.planDigest}</code></dd></div>}
      {decision.candidateDigest && <div><dt>Candidate digest</dt><dd><code title={decision.candidateDigest}>{decision.candidateDigest}</code></dd></div>}
    </dl>
    {!!actions.length && <div className="authority-actions">
      {actions.map((action, index) => {
        const scopes = Array.isArray(action.writeScope) ? action.writeScope : action.writeScope ? [action.writeScope] : [];
        return <article key={action.id || `${action.target || 'action'}:${index}`}>
          <header><span><small>계획 작업 {index + 1}</small><strong>{action.title || action.task || action.id || '승인 대상 작업'}</strong></span>{action.effect && <em className={`authority-effect effect-${action.effect}`}>{effectLabels[action.effect] || action.effect}<code>{action.effect}</code></em>}</header>
          {action.task && action.task !== action.title && <p>{action.task}</p>}
          <dl><div><dt>담당</dt><dd><code>{action.target || '미지정'}</code></dd></div><div><dt>쓰기 범위</dt><dd>{scopes.length ? <ul>{scopes.map((scope, scopeIndex) => <li key={`${scope}:${scopeIndex}`}><code>{scope}</code></li>)}</ul> : <span>쓰기 없음</span>}</dd></div></dl>
        </article>;
      })}
    </div>}
  </section>;
}

export function DecisionForm({ directorId, goal, onAccepted }) {
  const decision = goal?.ownerDecision;
  const answerId = useId();
  const [selected, setSelected] = useState('');
  const [answer, setAnswer] = useState('');
  const [result, action] = useActionState(async (_previous, formData) => {
    const payload = ownerDecisionPayload(formData.get('option'), formData.get('answer'));
    if (!payload) return { error: '선택지를 고르거나 답변을 입력하세요.' };
    try {
      await api(`/api/directors/${encodeURIComponent(directorId)}/goals/${encodeURIComponent(goal.id)}/decision`, {
        method: 'POST', body: payload,
      });
      setAnswer('');
      await onAccepted?.();
      return { ok: true };
    } catch (error) {
      return { error: error.message };
    }
  }, null);
  if (!decision?.required) return null;
  return <form action={action} className="decision-form">
    <AuthorityDecisionDetails decision={decision} />
    <fieldset className="decision-options"><legend className="sr-only">오너 결정 선택지</legend>
      {(decision.options || []).map((option, index) => <label key={option}>
        <input type="radio" name="option" value={option} checked={selected === option} onChange={() => { setSelected(option); setAnswer(''); }} />
        <span>{option}</span>
      </label>)}
    </fieldset>
    <div className="decision-answer"><label className="sr-only" htmlFor={answerId}>선택지 대신 직접 답변</label><input id={answerId} name="answer" value={answer} onChange={event => { setAnswer(event.target.value); if (event.target.value) setSelected(''); }} placeholder="선택지 대신 직접 답변" /><SubmitButton icon="check">결정 전달</SubmitButton></div>
    {result?.error && <p className="form-error" role="alert">{result.error}</p>}
  </form>;
}

export function WorkerIntervention({ directorId, taskId, disabled, onAccepted }) {
  const [draft, setDraft] = useState('');
  const [result, action] = useActionState(async (_previous, formData) => {
    const message = String(formData.get('message') || '').trim();
    if (!message) return { error: 'Worker에게 전달할 내용을 입력하세요.' };
    try {
      const receipt = await api(`/api/directors/${encodeURIComponent(directorId)}/tasks/${encodeURIComponent(taskId)}/interventions`, {
        method: 'POST', body: { message },
      });
      setDraft('');
      await onAccepted?.();
      return { ok: true, receipt };
    } catch (error) {
      return { error: error.message };
    }
  }, null);
  useEffect(() => { setDraft(''); }, [taskId]);
  return <form action={action} className="intervention-form">
    <label htmlFor="worker-message">Worker에게 지시</label>
    <textarea id="worker-message" name="message" rows="3" value={draft} onChange={event => setDraft(event.target.value)} disabled={disabled} placeholder="현재 작업 범위 안에서 수정하거나 확인할 내용을 전달합니다." />
    <SubmitButton className="secondary-button" disabled={disabled}>지시 전달</SubmitButton>
    {result?.receipt && <p className="receipt">{interventionReceiptText(result.receipt)}{result.receipt.deliveryError ? ` · ${result.receipt.deliveryError}` : ''}</p>}
    {result?.error && <p className="form-error" role="alert">{result.error}</p>}
  </form>;
}
