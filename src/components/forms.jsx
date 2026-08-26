import { useActionState, useEffect, useOptimistic, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { api } from '../lib/api.js';
import { interventionReceiptText, ownerDecisionPayload } from '../domain/operator-model.js';
import { formatClock, Icon, RichText } from './common.jsx';

function SubmitButton({ children, icon = 'send', className = 'primary-button', disabled = false }) {
  const { pending } = useFormStatus();
  return <button type="submit" className={className} disabled={pending || disabled}>{pending ? <span className="spinner" /> : <Icon name={icon} />}{pending ? '처리 중' : children}</button>;
}

export function DirectorComposer({ directorId, defaultMode = 'auto', onAccepted, messages, readOnly = false, readOnlyAction = null, hasOlder = false, loadingOlder = false, onLoadOlder, historyError = '' }) {
  const formRef = useRef(null);
  const chatRef = useRef(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState(defaultMode);
  const [follow, setFollow] = useState(true);
  const [optimisticMessages, addOptimistic] = useOptimistic(messages, (current, message) => [...current, message]);
  const [result, action] = useActionState(async (_previous, formData) => {
    const prompt = String(formData.get('prompt') || '').trim();
    const mode = String(formData.get('mode') || 'auto');
    if (!prompt) return { error: '요청을 입력하세요.' };
    const pendingId = `pending-${Date.now()}`;
    setFollow(true);
    addOptimistic({ id: pendingId, role: 'owner', text: prompt, at: new Date().toISOString(), pending: true });
    try {
      const accepted = await api(`/api/directors/${encodeURIComponent(directorId)}/messages`, {
        method: 'POST', body: { prompt, mode },
      });
      setDraft('');
      await onAccepted?.(accepted);
      return { ok: true, accepted };
    } catch (error) {
      return { error: error.message };
    }
  }, null);
  const latestMessage = optimisticMessages.at(-1);

  useEffect(() => {
    if (follow && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [latestMessage?.id, latestMessage?.text, latestMessage?.pending, follow]);

  return <div className="director-thread-layout">
    <div ref={chatRef} className="chat-stream" role="log" aria-live="polite" onScroll={event => setFollow(event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 48)}>
      {hasOlder && <button type="button" className="load-older chat-load-older" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder ? '이전 대화 불러오는 중…' : '이전 대화 불러오기'}</button>}
      {historyError && <p className="chat-history-error" role="alert">이전 대화를 불러오지 못했습니다. 다시 시도해 주세요.</p>}
      {!optimisticMessages.length && <div className="thread-empty"><strong>디렉터와 대화를 시작하세요.</strong><span>빠른 답변, 자율 판단, Worker 위임을 디렉터가 선택할 수 있습니다.</span></div>}
      {optimisticMessages.map(message => <article key={message.id} className={`chat-message ${message.role} ${message.pending ? 'pending' : ''}`}>
        <span className="chat-avatar">{message.role === 'owner' ? '나' : 'D'}</span>
        <div>
          <header><strong>{message.role === 'owner' ? '나' : '디렉터'}</strong><time>{formatClock(message.at)}</time>{message.kind && <em>{message.kind}</em>}</header>
          <div className="chat-copy"><RichText>{message.text}</RichText></div>
          {message.pending && <small>전송 중…</small>}
        </div>
      </article>)}
    </div>
    {readOnly ? <div className="goal-thread-footer"><span>이 기록은 현재 Goal에 한정됩니다.</span>{readOnlyAction}</div> : <form ref={formRef} action={action} className="director-composer" onKeyDown={event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) event.currentTarget.requestSubmit();
    }}>
      <label className="sr-only" htmlFor="director-prompt">디렉터에게 요청</label>
      <textarea id="director-prompt" name="prompt" rows="3" value={draft} onChange={event => setDraft(event.target.value)} placeholder="요청을 입력하세요. 디렉터가 답변·조사·Worker 위임을 판단합니다." />
      <footer>
        <label><span className="sr-only">처리 방식</span><select name="mode" value={mode} onChange={event => setMode(event.target.value)}>
          <option value="auto">자동</option>
          <option value="delegate">Worker 위임</option>
          <option value="conversation">답변만</option>
        </select></label>
        <span className="composer-hint">Ctrl+Enter로 전송</span>
        <SubmitButton>보내기</SubmitButton>
      </footer>
      {result?.error && <p className="form-error" role="alert">{result.error}</p>}
    </form>}
  </div>;
}

export function DecisionForm({ directorId, goal, onAccepted }) {
  const decision = goal?.ownerDecision;
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
    <div className="decision-options">
      {(decision.options || []).map((option, index) => <label key={option}>
        <input type="radio" name="option" value={option} checked={selected === option} onChange={() => { setSelected(option); setAnswer(''); }} />
        <span>{option}</span>
      </label>)}
    </div>
    <div className="decision-answer"><label className="sr-only" htmlFor={`decision-answer-${goal.id}`}>선택지 대신 직접 답변</label><input id={`decision-answer-${goal.id}`} name="answer" value={answer} onChange={event => { setAnswer(event.target.value); if (event.target.value) setSelected(''); }} placeholder="선택지 대신 직접 답변" /><SubmitButton icon="check">결정 전달</SubmitButton></div>
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
