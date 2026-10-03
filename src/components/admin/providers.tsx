import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, Download, FlaskConical, KeyRound, Languages, Pencil, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import { normalizeOpenAICompatibleBaseUrl, openAICompatibleBaseHasVersion, openAICompatibleChatUrl, type OpenAICompatibleDiagnostic, type OpenAICompatibleModel } from '../../../server/credential-broker/openai-compatible.mjs';
import { DEFAULT_TRANSLATION_PROMPT } from '../../domain/translation-prompt.mjs';
import { adminText, credentialDisplayLabel, credentialRemovalPrompt, dateTime, deeplText, googleQuotaText, openAIText, providerCredentialCount, providerLabel, providerQuotaDefaults, UNLIMITED_QUOTA, providerQuotaPeriods, translationCostText, usagePercent } from './text';
import { localeText } from './locale-text';
import type { AdminLocale, AmapBrowserStatus, Credential, MapSettings, Mutate, RequestData, Reveal, TranslationSettings } from './types';
import { Dialog, Panel, SecretCell, useConfirm } from './ui';

export function MapDisplayPanel({ value, locale, busy, mutate, openAmapBrowser }: { value: MapSettings; locale: AdminLocale; busy: boolean; mutate: Mutate; openAmapBrowser: () => void }) {
  const t = adminText[locale];
  const amapReady = value.amapBrowser.configured && value.amapBrowser.enabled;
  const [config, setConfig] = useState(() => ({ google: { ...value.google }, amap: amapReady ? { ...value.amap } : { china: false, international: false } }));
  useEffect(() => setConfig({ google: { ...value.google }, amap: amapReady ? { ...value.amap } : { china: false, international: false } }), [
    value.google.china, value.google.international, value.amap.china, value.amap.international, amapReady
  ]);
  const toggle = (provider: 'google' | 'amap', scope: 'china' | 'international', enabled: boolean) =>
    setConfig((current) => ({ ...current, [provider]: { ...current[provider], [scope]: enabled } }));
  return <Panel title={t.mapDisplayTitle}><form className="map-display-form" onSubmit={async (event) => {
    event.preventDefault();
    await mutate('/settings/maps', 'PUT', config, t.mapDisplaySaved);
  }}>
    <div className="map-display-grid">
      <span />
      <b>{t.mapChina}</b>
      <b>{t.mapInternational}</b>
      <strong>{t.googleMap}</strong>
      <label className="switch-field"><input name="googleChina" type="checkbox" checked={config.google.china} onChange={(event) => toggle('google', 'china', event.target.checked)} /><span /></label>
      <label className="switch-field"><input name="googleInternational" type="checkbox" checked={config.google.international} onChange={(event) => toggle('google', 'international', event.target.checked)} /><span /></label>
      <strong>{t.amapMap}</strong>
      <label className={`switch-field${amapReady ? '' : ' is-disabled'}`}><input name="amapChina" type="checkbox" checked={config.amap.china} disabled={!amapReady || busy} onChange={(event) => toggle('amap', 'china', event.target.checked)} /><span /></label>
      <label className={`switch-field${amapReady ? '' : ' is-disabled'}`}><input name="amapInternational" type="checkbox" checked={config.amap.international} disabled={!amapReady || busy} onChange={(event) => toggle('amap', 'international', event.target.checked)} /><span /></label>
    </div>
    {!amapReady && <div className="map-prerequisite"><div><KeyRound size={17} aria-hidden="true" /><span><strong>{t.amapBrowserEmpty}</strong><small>{t.amapBrowserSecurity}</small></span></div><button type="button" className="secondary-action" onClick={openAmapBrowser}>{t.configureAmapBrowser}</button></div>}
    <div className="panel-footer"><p>{t.mapDisplayHint}</p><button className="primary-action" disabled={busy}>{t.saveSettings}</button></div>
  </form></Panel>;
}
export function AmapBrowserSummary({ value, locale, busy, mutate, reveal, openEditor }: { value: AmapBrowserStatus; locale: AdminLocale; busy: boolean; mutate: Mutate; reveal: Reveal; openEditor: () => void }) {
  const confirm = useConfirm();
  const t = adminText[locale];
  if (!value.configured) return <article className="amap-browser-empty"><div><span className="credential-type-badge">{t.mapDisplayTitle}</span><strong>{t.amapBrowserTitle}</strong><small>{t.amapBrowserSecurity}</small></div><span className="badge disabled">{t.youdaoNotConfigured}</span><button type="button" className="secondary-action" onClick={openEditor}>{t.configureAmapBrowser}</button></article>;
  return <article className="provider-key-row amap-browser-row">
    <div className="provider-key-identity"><span className="credential-type-badge">{t.mapDisplayTitle}</span><strong>{credentialDisplayLabel(locale, value.label)}</strong><small>{t.amapBrowserSecurity}</small></div>
    <div className="amap-browser-secrets"><div><span>{t.amapApiKey}</span><SecretCell mask={value.mask} locale={locale} reveal={reveal} path="/maps/amap-browser/reveal" field="apiKey" /></div><div><span>{t.amapSecurityCode}</span><SecretCell mask={value.securityMask || '••••'} locale={locale} reveal={reveal} path="/maps/amap-browser/reveal" field="securityCode" /></div></div>
    <div className="provider-key-status"><span className={`badge ${value.status}`}>{t.status[value.status as keyof typeof t.status] || value.status}</span><small>{t.amapLastUsed}: {dateTime(value.lastUsedAt, locale)}</small><small>{t.amapUpdated}: {dateTime(value.updatedAt, locale)}</small></div>
    <div className="row-actions provider-key-actions"><button type="button" className="provider-action" title={t.edit} aria-label={t.edit} disabled={busy} onClick={openEditor}><Pencil size={14} aria-hidden="true" /></button><button type="button" className="provider-action" title={value.enabled ? t.stop : t.enable} aria-label={value.enabled ? t.stop : t.enable} disabled={busy} onClick={() => void mutate('/maps/amap-browser', 'PUT', { enabled: !value.enabled }, value.enabled ? t.stop : t.enable)}><Power size={14} aria-hidden="true" /></button><button type="button" className="provider-action danger" title={t.remove} aria-label={t.remove} disabled={busy} onClick={async () => {
      if (await confirm(t.confirmRemoveAmap)) void mutate('/maps/amap-browser', 'DELETE', undefined, t.amapBrowserRemoved);
    }}><Trash2 size={14} aria-hidden="true" /></button></div>
  </article>;
}
export function AmapBrowserDialog({ value, locale, busy, mutate, close }: { value: AmapBrowserStatus; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void }) {
  const t = adminText[locale];
  return <Dialog title={t.amapBrowserDialog} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const apiKey = String(values.get('apiKey') || '').trim();
    const securityCode = String(values.get('securityCode') || '').trim();
    const body = {
      label: String(values.get('label') || '').trim(), enabled: values.get('enabled') === 'on',
      ...(apiKey ? { apiKey } : {}), ...(securityCode ? { securityCode } : {})
    };
    const result = await mutate('/maps/amap-browser', value.configured ? 'PUT' : 'POST', body, t.amapBrowserSaved);
    if (result) close();
  }}>
    <label><span>{t.amapBrowserLabel}</span><input name="label" defaultValue={value.label} placeholder={t.amapBrowserPlaceholder} /></label>
    <label><span>{t.amapApiKey}</span><input name="apiKey" type="password" required={!value.configured} autoComplete="new-password" placeholder={value.configured ? t.replaceSecret : ''} /></label>
    <label><span>{t.amapSecurityCode}</span><input name="securityCode" type="password" required={!value.configured} autoComplete="new-password" placeholder={value.configured ? t.replaceSecret : ''} /></label>
    <label className="check"><input name="enabled" type="checkbox" defaultChecked={value.configured ? value.enabled : true} />{t.enable}</label>
    <p className="security-note">{t.amapBrowserSecurity}</p>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}
export function TranslationSettingsPanel({ value, credentials, deeplCredentials, openAICompatibleCredentials, locale, busy, mutate, reveal, request, openEditor, openDeepL, openOpenAICompatible }: {
  value: TranslationSettings; credentials: Credential[]; locale: AdminLocale; busy: boolean; mutate: Mutate; reveal: Reveal; request: RequestData;
  deeplCredentials: Credential[]; openAICompatibleCredentials: Credential[]; openDeepL: (value: 'create' | Credential) => void;
  openOpenAICompatible: (value: 'create' | Credential) => void;
  openEditor: (value: 'create' | Credential) => void;
}) {
  const confirm = useConfirm();
  const [testing, setTesting] = useState<Credential | null>(null);
  const t = adminText[locale];
  const cost = translationCostText(locale);
  const openAI = openAIText(locale);
  const googleRoute = value.routes?.find((route) => route.provider === 'google');
  const googleEnabled = value.googleTranslationEnabled && googleRoute?.enabled !== false;
  const [googlePriority, setGooglePriority] = useState(String(googleRoute?.priority ?? 40));
  useEffect(() => setGooglePriority(String(googleRoute?.priority ?? 40)), [googleRoute?.priority]);
  const [googleConcurrency, setGoogleConcurrency] = useState(String(value.googleTranslationConcurrency ?? 1));
  useEffect(() => setGoogleConcurrency(String(value.googleTranslationConcurrency ?? 1)), [value.googleTranslationConcurrency]);
  return <Panel title={t.translationTitle}>
    <div className="translation-settings">
      <div className="translation-toggle-row"><strong>{t.googleTranslationToggle}</strong><button type="button" className="toggle-switch" role="switch" aria-label={t.googleTranslationToggle} aria-checked={googleEnabled} disabled={busy}
        onClick={() => void mutate('/settings/translation', 'PUT', { googleTranslationEnabled: !googleEnabled }, t.translationSaved)}><span aria-hidden="true" /></button></div>
      <p className="security-note translation-notice">{cost.google}</p>
      <form className="translation-google-priority admin-form" onSubmit={async (event) => {
        event.preventDefault();
        if (await mutate('/settings/translation/routes', 'PUT', { routes: [{ id: 'google', priority: Number(googlePriority) }] }, t.translationSaved)) {
          await mutate('/settings/translation', 'PUT', { googleTranslationConcurrency: Number(googleConcurrency) }, t.translationSaved);
        }
      }}><label><span>{openAI.routePriority}</span><input name="googleTranslationPriority" type="number" min="1" max="10000" required value={googlePriority} onChange={(event) => setGooglePriority(event.target.value)} /></label>
      <ConcurrencyField value={googleConcurrency} onChange={setGoogleConcurrency} locale={locale} /><button type="submit" className="secondary-action" disabled={busy}>{t.save}</button><small>{openAI.routingHint}</small></form>
      <section className="translation-provider deepl-provider">
        <header className="translation-provider-header"><div className="translation-provider-title"><span className="provider-group-icon" aria-hidden="true"><Languages size={18} /></span><div><h3>DeepL API Free</h3><span className="provider-key-count">{providerCredentialCount(locale, deeplCredentials.length)}</span></div></div><button type="button" className="secondary-action" disabled={busy} onClick={() => openDeepL('create')}><Plus size={14} aria-hidden="true" />{deeplText(locale).add}</button></header>
        <p className="security-note translation-notice">{deeplText(locale).notice}</p>
        {deeplCredentials.length ? <div className="provider-key-list">{deeplCredentials.map((credential) => <CredentialRowCompact key={credential.id} item={credential} locale={locale} reveal={reveal} actions={(item) => <>
          <button type="button" className="provider-action" aria-label={t.edit} title={t.edit} disabled={busy} onClick={() => openDeepL(item)}><Pencil size={14} /></button>
          <button type="button" className="provider-action" aria-label={item.enabled ? t.stop : t.enable} title={item.enabled ? t.stop : t.enable} disabled={busy} onClick={() => void mutate(`/providers/${item.id}`, 'PUT', { enabled: !item.enabled }, t.keySaved)}><Power size={14} /></button>
          <button type="button" className="provider-action" aria-label={t.test} title={t.test} disabled={busy || !item.enabled} onClick={() => void mutate(`/providers/${item.id}/test`, 'POST', undefined, t.testSuccess)}><FlaskConical size={14} /></button>
          <button type="button" className="provider-action danger" aria-label={t.remove} title={t.remove} disabled={busy} onClick={async () => { if (await confirm(credentialRemovalPrompt(locale, item.label))) void mutate(`/providers/${item.id}`, 'DELETE', undefined, t.remove); }}><Trash2 size={14} /></button>
        </>} />)}</div> : <div className="provider-empty-state translation-empty-state"><KeyRound size={15} aria-hidden="true" /><span>{t.youdaoNotConfigured}</span></div>}
      </section>
      <section className="translation-provider">
        <header className="translation-provider-header"><div className="translation-provider-title"><span className="provider-group-icon" aria-hidden="true"><Languages size={18} /></span><div><h3>{t.providers.youdao}</h3><span className={`provider-key-count${credentials.length ? '' : ' is-empty'}`}>{providerCredentialCount(locale, credentials.length)}</span></div></div><button type="button" className="secondary-action" disabled={busy} onClick={() => openEditor('create')}><Plus size={14} aria-hidden="true" />{t.addKey}</button></header>
        <p className="security-note translation-notice">{cost.youdao}</p>
        {credentials.length ? <div className="provider-key-list youdao-key-list">{credentials.map((credential) => <CredentialRowCompact key={credential.id} item={credential} locale={locale} reveal={reveal} revealPath={`/providers/${credential.id}/reveal-fields`} secrets={[
          { label: t.youdaoAppKey, mask: credential.fieldMasks?.appKey || credential.mask, field: 'appKey' },
          { label: t.youdaoAppSecret, mask: credential.fieldMasks?.appSecret || credential.mask, field: 'appSecret' }
        ]} actions={(item) => <><button type="button" className="provider-action" title={t.edit} aria-label={t.edit} disabled={busy} onClick={() => openEditor(item)}><Pencil size={14} aria-hidden="true" /></button><button type="button" className="provider-action" title={item.enabled ? t.stop : t.enable} aria-label={item.enabled ? t.stop : t.enable} disabled={busy} onClick={() => void mutate(`/providers/${item.id}`, 'PUT', { enabled: !item.enabled }, item.enabled ? t.stop : t.enable)}><Power size={14} aria-hidden="true" /></button><button type="button" className="provider-action" title={t.test} aria-label={t.test} disabled={busy} onClick={() => void mutate(`/providers/${item.id}/test`, 'POST', undefined, t.testSuccess)}><FlaskConical size={14} aria-hidden="true" /></button><button type="button" className="provider-action danger" title={t.remove} aria-label={t.remove} disabled={busy} onClick={async () => { if (await confirm(credentialRemovalPrompt(locale, item.label))) void mutate(`/providers/${item.id}`, 'DELETE', undefined, t.remove); }}><Trash2 size={14} aria-hidden="true" /></button></>} />)}</div> : <div className="provider-empty-state translation-empty-state"><KeyRound size={15} aria-hidden="true" /><span>{t.youdaoNotConfigured}</span></div>}
      </section>
      <section className="translation-provider openai-provider">
        <header className="translation-provider-header"><div className="translation-provider-title"><span className="provider-group-icon" aria-hidden="true"><Languages size={18} /></span><div><h3>{providerLabel(locale, 'openai-compatible')}</h3><span className={`provider-key-count${openAICompatibleCredentials.length ? '' : ' is-empty'}`}>{providerCredentialCount(locale, openAICompatibleCredentials.length)}</span></div></div><button type="button" className="secondary-action" disabled={busy} onClick={() => openOpenAICompatible('create')}><Plus size={14} aria-hidden="true" />{openAI.add}</button></header>
        <p className="security-note translation-notice">{openAI.notice}</p>
        {openAICompatibleCredentials.length ? <div className="provider-key-list">{openAICompatibleCredentials.map((credential) => <CredentialRowCompact key={credential.id} item={credential} locale={locale} reveal={reveal} revealPath={`/providers/${credential.id}/reveal-fields`} secrets={[{ label: openAI.key, mask: credential.openAICompatible?.apiKeyMask || credential.mask, field: 'apiKey' }]} actions={(item) => <><button type="button" className="provider-action" title={t.edit} aria-label={t.edit} disabled={busy} onClick={() => openOpenAICompatible(item)}><Pencil size={14} /></button><button type="button" className="provider-action" title={item.enabled ? t.stop : t.enable} aria-label={item.enabled ? t.stop : t.enable} disabled={busy} onClick={() => void mutate(`/providers/${item.id}`, 'PUT', { enabled: !item.enabled }, item.enabled ? t.stop : t.enable)}><Power size={14} /></button><button type="button" className="provider-action" title={t.test} aria-label={t.test} disabled={busy} onClick={() => setTesting(item)}><FlaskConical size={14} /></button><button type="button" className="provider-action danger" title={t.remove} aria-label={t.remove} disabled={busy} onClick={async () => { if (await confirm(credentialRemovalPrompt(locale, item.label))) void mutate(`/providers/${item.id}`, 'DELETE', undefined, t.remove); }}><Trash2 size={14} /></button></>} />)}</div> : <div className="provider-empty-state translation-empty-state"><KeyRound size={15} aria-hidden="true" /><span>{t.youdaoNotConfigured}</span></div>}
      </section>
    </div>
    {testing && <ProviderTestDialog credential={testing} locale={locale} request={request} close={() => setTesting(null)} refresh={() => void mutate('/providers', 'GET', undefined, '')} />}
  </Panel>;
}
const concurrencyText = (locale: AdminLocale) => ({
  'zh-CN': { label: '并发数', hint: '同时进行的请求数（1-50）；超出时排队等待。' },
  'zh-TW': { label: '並發數', hint: '同時進行的請求數（1-50）；超出時排隊等待。' },
  en: { label: 'Concurrency', hint: 'Requests in flight at once (1-50); extra requests wait.' }
} as Record<string, { label: string; hint: string }>)[locale] || { label: 'Concurrency', hint: 'Requests in flight at once (1-50); extra requests wait.' };
const ConcurrencyField = ({ value, onChange, locale }: { value: string; onChange: (value: string) => void; locale: AdminLocale }) =>
  <label><span>{concurrencyText(locale).label}</span><input name="maxConcurrency" type="number" min="1" max="50" step="1" required value={value} onChange={(event) => onChange(event.target.value)} /><small>{concurrencyText(locale).hint}</small></label>;

export function YoudaoCredentialDialog({ value, locale, busy, mutate, close }: {
  value?: Credential; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void;
}) {
  const t = adminText[locale];
  const creating = !value;
  const [label, setLabel] = useState(value?.label || '');
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [visibleKey, setVisibleKey] = useState(false);
  const [visibleSecret, setVisibleSecret] = useState(false);
  const [quotaLimit, setQuotaLimit] = useState(String(value?.quotaLimit || providerQuotaDefaults.youdao));
  const [quotaPeriod, setQuotaPeriod] = useState<'day' | 'month'>(value?.quotaPeriod || 'month');
  const [translationPriority, setTranslationPriority] = useState(String(value?.translationPriority ?? 30));
  const [maxConcurrency, setMaxConcurrency] = useState(String(value?.maxConcurrency ?? 1));
  const [enabled, setEnabled] = useState(value?.enabled ?? true);
  return <Dialog title={creating ? t.addKey : t.edit} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    const key = appKey.trim();
    const secret = appSecret.trim();
    if (creating ? (!key || !secret) : Boolean(key) !== Boolean(secret)) return;
    const body = {
      provider: 'youdao', label: label.trim() || `${t.providers.youdao} ${t.key}`,
      ...(key && secret ? { secret: JSON.stringify({ appKey: key, appSecret: secret }) } : {}),
      quotaLimit: Number(quotaLimit), quotaPeriod, translationPriority: Number(translationPriority),
      maxConcurrency: Number(maxConcurrency), enabled
    };
    const result = await mutate(creating ? '/providers' : `/providers/${value.id}`, creating ? 'POST' : 'PUT', body, t.youdaoSaved);
    if (result) close();
  }}>
    <p className="security-note translation-notice">{translationCostText(locale).youdao}</p>
    <label><span>{t.name}</span><input name="label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t.autoName} /></label>
    <label className="secret-input-field"><span>{t.youdaoAppKey}</span><div><input name="youdaoAppKey" type={visibleKey ? 'text' : 'password'} value={appKey} required={creating || Boolean(appSecret)} autoComplete="new-password" placeholder={creating ? '' : t.replaceSecret} onChange={(event) => setAppKey(event.target.value)} /><button type="button" className="inline-toggle" onClick={() => setVisibleKey((current) => !current)}>{visibleKey ? t.hideSecret : t.showSecret}</button></div></label>
    <label className="secret-input-field"><span>{t.youdaoAppSecret}</span><div><input name="youdaoAppSecret" type={visibleSecret ? 'text' : 'password'} value={appSecret} required={creating || Boolean(appKey)} autoComplete="new-password" placeholder={creating ? '' : t.replaceSecret} onChange={(event) => setAppSecret(event.target.value)} /><button type="button" className="inline-toggle" onClick={() => setVisibleSecret((current) => !current)}>{visibleSecret ? t.hideSecret : t.showSecret}</button></div></label>
    <label><span>{t.quotaUsage}</span><input name="quotaLimit" type="number" min="1" max="100000000" required value={quotaLimit} onChange={(event) => setQuotaLimit(event.target.value)} /></label>
    <label><span>{t.quotaReset}</span><select name="quotaPeriod" value={quotaPeriod} onChange={(event) => setQuotaPeriod(event.target.value as 'day' | 'month')}><option value="day">{t.quotaDay}</option><option value="month">{t.quotaMonth}</option></select></label>
    <label><span>{openAIText(locale).priority}</span><input name="translationPriority" type="number" min="1" max="10000" required value={translationPriority} onChange={(event) => setTranslationPriority(event.target.value)} /></label>
    <ConcurrencyField value={maxConcurrency} onChange={setMaxConcurrency} locale={locale} />
    <label className="check"><input name="enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t.enable}</label>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}
export const supportsChatCompletions = (model: OpenAICompatibleModel) => !model.supportedEndpoints
  || model.supportedEndpoints.some((endpoint) => endpoint.endsWith('/chat/completions'));
export function TranslationModelPicker({ value, models, locale, fetching, fetchDisabled, onChange, onFetch }: {
  value: string; models: OpenAICompatibleModel[]; locale: AdminLocale; fetching: boolean; fetchDisabled: boolean;
  onChange: (value: string) => void; onFetch: () => void;
}) {
  const text = openAIText(locale);
  const labels = localeText[locale].model;
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const visible = models.filter((item) => item.id.toLowerCase().includes(query.trim().toLowerCase()));
  const incompatible = models.filter((item) => !supportsChatCompletions(item)).length;
  useEffect(() => {
    setOpen(models.length > 0); setQuery(''); setActive(-1);
    if (models.length && root.current?.contains(document.activeElement)) input.current?.focus();
  }, [models]);
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);
  const choose = (item: OpenAICompatibleModel) => {
    if (!supportsChatCompletions(item)) return;
    onChange(item.id); setOpen(false); setQuery(''); setActive(-1); input.current?.focus();
  };
  const showAll = () => { setQuery(''); setActive(-1); setOpen(true); input.current?.focus(); };
  const keyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && models.length) {
      event.preventDefault();
      const items = open ? visible : models;
      const choices = items.map((item, index) => supportsChatCompletions(item) ? index : -1).filter((index) => index >= 0);
      const current = open ? choices.indexOf(active) : -1;
      const next = current < 0 ? event.key === 'ArrowDown' ? 0 : choices.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      if (!open) setQuery('');
      setOpen(true); setActive(choices[next] ?? -1);
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      if (visible[active]) choose(visible[active]); else setOpen(false);
    }
  };
  return <div className="model-picker-field"><label htmlFor={id}><span>{text.model}</span></label>
    <div ref={root} className="model-picker" onKeyDown={(event) => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    }} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <div className="model-picker-controls"><div className="model-picker-input">
        <input ref={input} id={id} name="model" required autoComplete="off" role="combobox" aria-autocomplete="list"
          aria-expanded={open && models.length > 0} aria-controls={`${id}-list`} aria-describedby={`${id}-hint`}
          aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined} value={value}
          onClick={() => { if (models.length) showAll(); }} onKeyDown={keyDown}
          onChange={(event) => { onChange(event.target.value); setQuery(event.target.value); setActive(-1); setOpen(models.length > 0); }} />
        {models.length > 0 && <button type="button" className="model-picker-toggle" aria-label={labels.all}
          aria-expanded={open} aria-controls={`${id}-list`} onClick={() => open ? setOpen(false) : showAll()}><ChevronDown size={16} aria-hidden="true" /></button>}
      </div><button type="button" className="model-fetch-button" title={fetching ? text.fetchingModels : text.fetchModels}
        aria-label={fetching ? text.fetchingModels : text.fetchModels} aria-busy={fetching} disabled={fetchDisabled} onClick={onFetch}>
        {fetching ? <RefreshCw size={18} className="is-spinning" aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}
      </button></div>
      {open && models.length > 0 && <div className="model-picker-dropdown">
        <div className="model-picker-count">{visible.length} / {models.length} {labels.count}{incompatible > 0 && ` · ${incompatible} ${labels.blocked}`}</div>
        <div id={`${id}-list`} role="listbox" aria-label={text.model} className="model-picker-options">
          {visible.map((item, index) => <div key={item.id} id={`${id}-option-${index}`} role="option"
            aria-selected={item.id === value} aria-disabled={!supportsChatCompletions(item)}
            className={`model-picker-option${active === index ? ' is-active' : ''}`}
            onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}>
            <span><span className="model-picker-name">{item.id}</span>{!supportsChatCompletions(item) && <small>{labels.unavailable}{item.supportedEndpoints?.length ? ` · ${item.supportedEndpoints.join(', ')}` : ''}</small>}</span>
            {item.id === value && <Check size={16} aria-hidden="true" />}
          </div>)}
        </div>{!visible.length && <p className="model-picker-empty" role="status">{labels.empty}</p>}
      </div>}
    </div><small id={`${id}-hint`} role="status">{fetching ? text.fetchingModels : models.length ? `${models.length} ${labels.count} · ${labels.hint}` : labels.hint}</small>
  </div>;
}
export function OpenAICompatibleCredentialDialog({ value, locale, busy, mutate, request, close }: {
  value?: Credential; locale: AdminLocale; busy: boolean; mutate: Mutate; request: RequestData; close: () => void;
}) {
  const t = adminText[locale];
  const text = openAIText(locale);
  const creating = !value;
  const [label, setLabel] = useState(value?.label || '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(value?.openAICompatible?.baseUrl || '');
  const [model, setModel] = useState(value?.openAICompatible?.model || '');
  const currentModel = useRef(model);
  currentModel.current = model;
  const savedEffort = value?.openAICompatible?.reasoningEffort;
  const [reasoningEffort, setReasoningEffort] = useState(savedEffort && savedEffort !== 'default' ? savedEffort : 'low');
  const [maxTokens, setMaxTokens] = useState(String(value?.openAICompatible?.maxTokens || 8192));
  const [maxConcurrency, setMaxConcurrency] = useState(String(value?.maxConcurrency ?? 3));
  const [translationPriority, setTranslationPriority] = useState(String(value?.translationPriority ?? 10));
  const [translationPrompt, setTranslationPrompt] = useState(value?.translationPrompt || DEFAULT_TRANSLATION_PROMPT);
  const endpointBase = normalizeOpenAICompatibleBaseUrl(baseUrl);
  const endpointVersioned = Boolean(endpointBase && (/\/chat\/completions\/?$/iu.test(baseUrl.trim()) || openAICompatibleBaseHasVersion(endpointBase)));
  const [models, setModels] = useState<OpenAICompatibleModel[]>([]);
  const modelFetchSequence = useRef(0);
  const reasoningListId = useId();
  const selectedModel = models.find((item) => item.id === model);
  const modelCompatible = !selectedModel || supportsChatCompletions(selectedModel);
  const selectModel = (id: string, available = models) => {
    setModel(id);
    const efforts = available.find((item) => item.id === id)?.reasoningEfforts?.filter((effort) => effort !== 'default');
    setReasoningEffort(efforts?.length && !efforts.includes('low') ? efforts[0] : 'low');
  };
  const modelText = localeText[locale].model;
  const capabilityText = { unknown: modelText.reasoningUnknown, known: modelText.reasoningKnown, incompatible: modelText.unavailable, endpoint: modelText.endpointHint };
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelFetchState, setModelFetchState] = useState<'idle' | 'empty' | 'error'>('idle');
  const [modelFetchError, setModelFetchError] = useState('');
  const [visible, setVisible] = useState(false);
  const [quotaLimit, setQuotaLimit] = useState(String(value?.quotaLimit || providerQuotaDefaults['openai-compatible']));
  const [unlimited, setUnlimited] = useState((value?.quotaLimit || providerQuotaDefaults['openai-compatible']) >= UNLIMITED_QUOTA);
  const [enabled, setEnabled] = useState(value?.enabled ?? true);
  const invalidateModels = () => { modelFetchSequence.current++; setFetchingModels(false); setModels([]); setModelFetchState('idle'); };
  const fetchModels = async () => {
    const sequence = ++modelFetchSequence.current;
    setFetchingModels(true); setModels([]);
    setModelFetchError('');
    try {
      const result = await request<{ models?: OpenAICompatibleModel[]; baseUrl?: string }>('/providers/openai-compatible/models', { method: 'POST', body: JSON.stringify({
        ...(value ? { credentialId: value.id } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        baseUrl: baseUrl.trim()
      }) });
      if (sequence !== modelFetchSequence.current) return;
      if (result?.baseUrl) setBaseUrl(result.baseUrl);
      const available = result?.models || [];
      setModels(available);
      if (!currentModel.current.trim()) selectModel(available.find(supportsChatCompletions)?.id || '', available);
      setModelFetchState(available.length ? 'idle' : 'empty');
    } catch (error) {
      if (sequence !== modelFetchSequence.current) return;
      setModelFetchState('error');
      setModelFetchError(error instanceof Error ? error.message : String(error));
    } finally { if (sequence === modelFetchSequence.current) setFetchingModels(false); }
  };
  return <Dialog title={creating ? text.add : t.edit} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    if (!modelCompatible) return;
    const key = apiKey.trim();
    const body = {
      provider: 'openai-compatible', label: label.trim() || `${providerLabel(locale, 'openai-compatible')} ${t.key}`,
      ...(key ? { apiKey: key } : {}), baseUrl: baseUrl.trim(), model: model.trim(), reasoningEffort,
      maxTokens: Number(maxTokens), translationPriority: Number(translationPriority), translationPrompt: translationPrompt.trim(),
      quotaLimit: unlimited ? UNLIMITED_QUOTA : Number(quotaLimit), quotaPeriod: 'day',
      maxConcurrency: Number(maxConcurrency), enabled
    };
    const result = await mutate(creating ? '/providers' : `/providers/${value.id}`, creating ? 'POST' : 'PUT', body, text.saved);
    if (result) close();
  }}>
    <p className="security-note translation-notice">{text.notice}</p>
    <label><span>{t.name}</span><input name="label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t.autoName} /></label>
    <label className="secret-input-field"><span>{text.key}</span><div><input name="apiKey" type={visible ? 'text' : 'password'} value={apiKey} required={creating} autoComplete="new-password" placeholder={creating ? '' : value?.openAICompatible?.apiKeyMask || t.replaceSecret} onChange={(event) => { setApiKey(event.target.value); invalidateModels(); }} /><button type="button" className="inline-toggle" onClick={() => setVisible((current) => !current)}>{visible ? t.hideSecret : t.showSecret}</button></div></label>
    <label><span>{text.endpoint}</span><input name="baseUrl" type="url" required value={baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => { setBaseUrl(event.target.value); invalidateModels(); }} /><small>{capabilityText.endpoint}</small>{endpointBase && <small className="endpoint-preview">{localeText[locale].test.endpointPreview}: <code>{openAICompatibleChatUrl(endpointVersioned ? endpointBase : `${endpointBase}/v1`)}</code>{!endpointVersioned && ` · ${localeText[locale].test.endpointProbe}`}</small>}</label>
    <TranslationModelPicker value={model} models={models} locale={locale} fetching={fetchingModels}
      fetchDisabled={busy || fetchingModels || !baseUrl.trim() || creating && !apiKey.trim()}
      onChange={selectModel} onFetch={() => void fetchModels()} />
    {!modelCompatible && <p className="field-error" role="alert">{capabilityText.incompatible}</p>}
    {modelFetchState === 'empty' && <p className="field-error" role="status">{text.modelsEmpty}</p>}
    {modelFetchState === 'error' && <p className="field-error" role="alert">{text.modelsFailed}{modelFetchError && `: ${modelFetchError}`}</p>}
    <label><span>{text.reasoning}</span><input name="reasoningEffort" list={reasoningListId} required pattern={'[a-z][a-z0-9_\\-]{0,31}'} value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)} /><datalist id={reasoningListId}>{selectedModel?.reasoningEfforts?.filter((effort) => effort !== 'default').map((effort) => <option key={effort} value={effort} />)}</datalist><small>{selectedModel?.reasoningEfforts ? capabilityText.known : capabilityText.unknown}</small></label>
    <label><span>{text.maxTokens}</span><input name="maxTokens" type="number" min="1024" max="32768" step="1" required value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} /></label>
    <label><span>{text.priority}</span><input name="translationPriority" type="number" min="1" max="10000" step="1" required value={translationPriority} onChange={(event) => setTranslationPriority(event.target.value)} /></label>
    <label><span>{text.prompt}</span><textarea name="translationPrompt" maxLength={4000} value={translationPrompt} onChange={(event) => setTranslationPrompt(event.target.value)} /><small>{text.promptHint}</small>{translationPrompt.trim() !== DEFAULT_TRANSLATION_PROMPT && <button type="button" className="compact-action prompt-reset" onClick={() => setTranslationPrompt(DEFAULT_TRANSLATION_PROMPT)}>{localeText[locale].test.restoreDefaultPrompt}</button>}</label>
    <label className="check"><input name="unlimitedQuota" type="checkbox" checked={unlimited} onChange={(event) => { setUnlimited(event.target.checked); if (!event.target.checked && Number(quotaLimit) >= UNLIMITED_QUOTA) setQuotaLimit('1000'); }} />{localeText[locale].ui.unlimitedQuota}</label>
    {!unlimited && <label><span>{t.quotaUsage}</span><input name="quotaLimit" type="number" min="1" max={UNLIMITED_QUOTA - 1} required value={quotaLimit} onChange={(event) => setQuotaLimit(event.target.value)} /></label>}
    <ConcurrencyField value={maxConcurrency} onChange={setMaxConcurrency} locale={locale} />
    <label className="check"><input name="enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t.enable}</label>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}
export function ProviderCredentialDialog({ value, initialProvider = 'amap', locale, busy, mutate, close }: {
  value?: Credential; initialProvider?: string; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void;
}) {
  const t = adminText[locale];
  const googleQuota = googleQuotaText(locale);
  const [provider, setProvider] = useState(value?.provider || initialProvider);
  const [label, setLabel] = useState(value?.label || '');
  const [secret, setSecret] = useState('');
  const [visible, setVisible] = useState(false);
  const [quotaLimit, setQuotaLimit] = useState(String(value?.quotaLimit || providerQuotaDefaults[initialProvider] || providerQuotaDefaults.amap));
  const [quotaPeriod, setQuotaPeriod] = useState<'day' | 'month'>(value?.quotaPeriod || 'month');
  const [quotaUsedBaseline, setQuotaUsedBaseline] = useState(String(value?.quotaBaseline || 0));
  const [translationPriority, setTranslationPriority] = useState(String(value?.translationPriority ?? 20));
  const [maxConcurrency, setMaxConcurrency] = useState(String(value?.maxConcurrency ?? 1));
  const [enabled, setEnabled] = useState(value?.enabled ?? true);
  const creating = !value;
  const changeProvider = (next: string) => {
    setProvider(next);
    setQuotaLimit(String(providerQuotaDefaults[next] || 100));
    setQuotaPeriod(providerQuotaPeriods[next] || 'day');
    setQuotaUsedBaseline('0');
  };
  return <Dialog title={creating ? provider === 'deepl' ? deeplText(locale).add : t.addMapKey : t.edit} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    const secretValue = secret.trim();
    const body = {
      provider,
      label: label.trim() || `${providerLabel(locale, provider)} ${t.key}`,
      ...(secretValue ? { secret: secretValue } : {}),
      quotaLimit: Number(quotaLimit), quotaPeriod,
      ...(provider === 'deepl' ? { translationPriority: Number(translationPriority) } : {}),
      ...(provider === 'google-geocoding' ? { quotaUsedBaseline: Number(quotaUsedBaseline) } : {}),
      maxConcurrency: Number(maxConcurrency), enabled
    };
    const result = await mutate(creating ? '/providers' : `/providers/${value.id}`, creating ? 'POST' : 'PUT', body, t.keySaved);
    if (result) close();
  }}>
    {provider === 'deepl' ? <p className="security-note">{deeplText(locale).notice}</p> : <label><span>{t.provider}</span><select name="provider" value={provider} disabled={!creating} onChange={(event) => changeProvider(event.target.value)}><option value="amap">{providerLabel(locale, 'amap')}</option><option value="baidu">{providerLabel(locale, 'baidu')}</option><option value="tencent">{providerLabel(locale, 'tencent')}</option><option value="onemap">{providerLabel(locale, 'onemap')}</option><option value="geoapify">{providerLabel(locale, 'geoapify')}</option><option value="google-geocoding">{providerLabel(locale, 'google-geocoding')}</option><option value="mappls">{providerLabel(locale, 'mappls')}</option>{!creating && !['amap', 'baidu', 'tencent', 'onemap', 'geoapify', 'google-geocoding', 'mappls'].includes(provider) && <option value={provider}>{providerLabel(locale, provider)}</option>}</select></label>}
    <label><span>{t.name}</span><input name="label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t.autoName} /></label>
    <label className="secret-input-field"><span>{t.key}</span><div><input name="secret" type={visible ? 'text' : 'password'} value={secret} required={creating} autoComplete="new-password" placeholder={creating ? '' : t.replaceSecret} onChange={(event) => setSecret(event.target.value)} /><button type="button" className="inline-toggle" onClick={() => setVisible((current) => !current)}>{visible ? t.hideSecret : t.showSecret}</button></div></label>
    {provider === 'geoapify' && <p className="security-note">{t.geoapifyWorkerHint}</p>}
    {provider === 'google-geocoding' && <p className="security-note">{googleQuota.official}</p>}
    <label><span>{provider === 'deepl' ? deeplText(locale).budget : provider === 'google-geocoding' ? googleQuota.budget : t.quotaUsage}</span><input name="quotaLimit" type="number" min="1" max="100000000" required value={quotaLimit} onChange={(event) => setQuotaLimit(event.target.value)} /></label>
    {provider === 'deepl' ? <p className="security-note">{deeplText(locale).reset}</p> : <label><span>{t.quotaReset}</span><select name="quotaPeriod" value={quotaPeriod} onChange={(event) => setQuotaPeriod(event.target.value as 'day' | 'month')}><option value="day">{t.quotaDay}</option><option value="month">{t.quotaMonth}</option></select></label>}
    {provider === 'google-geocoding' && <label><span>{googleQuota.baseline}</span><input name="quotaUsedBaseline" type="number" min="0" max={quotaLimit || '9000'} required value={quotaUsedBaseline} onChange={(event) => setQuotaUsedBaseline(event.target.value)} /><small>{googleQuota.hint}</small></label>}
    {provider === 'deepl' && <label><span>{openAIText(locale).priority}</span><input name="translationPriority" type="number" min="1" max="10000" required value={translationPriority} onChange={(event) => setTranslationPriority(event.target.value)} /><small>{openAIText(locale).routingHint}</small></label>}
    <ConcurrencyField value={maxConcurrency} onChange={setMaxConcurrency} locale={locale} />
    <label className="check"><input name="enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t.enable}</label>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}
export const providerCredentialOrder = ['amap', 'baidu', 'tencent', 'onemap', 'geoapify', 'google-geocoding', 'mappls'] as const;
export interface CredentialSecretField { label: string; mask: string; field: string }
export const CredentialRowCompact = ({ item, locale, reveal, actions, secrets, revealPath }: {
  item: Credential; locale: AdminLocale; reveal: Reveal; actions: (value: Credential) => ReactNode; secrets?: CredentialSecretField[]; revealPath?: string;
}) => {
  const t = adminText[locale];
  const openAI = item.openAICompatible ? openAIText(locale) : undefined;
  const secretFields = secrets || [{ label: t.key, mask: item.mask, field: 'secret' }];
  const windows = item.quotaWindows?.length ? item.quotaWindows : [{
    service: item.quotaService, period: item.quotaPeriod, used: item.quotaUsed, limit: item.quotaLimit,
    remaining: item.quotaRemaining, resetAt: item.quotaResetAt, usageSource: item.quotaUsageSource, exhausted: item.quotaUsed >= item.quotaLimit
  }];
  return <article className="provider-key-row">
    <div className="provider-key-name"><span>{t.name}</span><strong>{credentialDisplayLabel(locale, item.label)}</strong>{item.translationPriority !== undefined && <small>{openAIText(locale).routePriority}: {item.translationPriority}</small>}{item.maxConcurrency !== undefined && <small>{concurrencyText(locale).label}: {item.maxConcurrency}</small>}{item.openAICompatible && openAI && <small className="provider-key-config"><span>{openAI.endpoint}: {item.openAICompatible.baseUrl}</span><span>{openAI.model}: {item.openAICompatible.model}</span></small>}</div>
    <div className={`provider-key-secrets${secretFields.length > 1 ? ' is-paired' : ''}`}>{secretFields.map((secret) => <div className="provider-key-secret" key={secret.field}><span>{secret.label}</span><SecretCell mask={secret.mask} locale={locale} reveal={reveal} path={revealPath || `/providers/${item.id}/reveal`} field={secret.field} /></div>)}</div>
    <div className="provider-key-status"><span className={`badge ${item.status}`}>{t.status[item.status as keyof typeof t.status] || item.status}</span>{item.expiresAt && <small>{dateTime(item.expiresAt, locale)}</small>}<small>{t.lastSuccess}: {dateTime(item.lastSuccessAt, locale)}</small></div>
    <div className="quota-cell">{item.characterQuota ? <div className="quota-window">
      <b>{item.characterQuota.used.toLocaleString(locale)} / {item.characterQuota.limit.toLocaleString(locale)} {deeplText(locale).characters}</b>
      <small>{deeplText(locale).budget}: {item.quotaLimit.toLocaleString(locale)}</small>
      <small>{deeplText(locale).provider}: {item.characterQuota.providerUsed.toLocaleString(locale)} / {item.characterQuota.providerLimit.toLocaleString(locale)}</small>
      <small>{item.characterQuota.observedAt ? `${deeplText(locale).observed}: ${dateTime(item.characterQuota.observedAt, locale)}` : deeplText(locale).unknown}</small>
      <small>{item.characterQuota.resetAt ? dateTime(item.characterQuota.resetAt, locale) : deeplText(locale).reset}</small>
    </div> : windows.map((window) => window.limit >= UNLIMITED_QUOTA ? <div className="quota-window" key={`${window.service}-${window.period}`}>
      <b>{window.used.toLocaleString(locale)} · {localeText[locale].ui.unlimitedQuota}</b>
      <small>{t.quotaReset} {dateTime(window.resetAt, locale)}</small>
    </div> : <div className="quota-window" key={`${window.service}-${window.period}`}>
      <b>{window.used.toLocaleString(locale)}/{window.limit.toLocaleString(locale)} {window.period === 'month' ? t.quotaMonth : t.quotaDay}</b>
      <span className={`quota-bar${usagePercent(window.used, window.limit) >= 100 ? ' full' : usagePercent(window.used, window.limit) >= 80 ? ' high' : ''}`}><i style={{ width: `${usagePercent(window.used, window.limit)}%` }} /></span>
      <small>{window.remaining.toLocaleString(locale)} {t.quotaRemaining}</small>
      <small>{t.quotaReset} {dateTime(window.resetAt, locale)}</small>
    </div>)}</div>
    <div className="row-actions provider-key-actions">{actions(item)}</div>
  </article>;
};
export const ProviderCredentialsPanel = ({ values, locale, reveal, busy, mutate, openEditor, openProvider }: { values: Credential[]; locale: AdminLocale; reveal: Reveal; busy: boolean; mutate: Mutate; openEditor: (value: Credential) => void; openProvider: (provider: string) => void }) => {
  const confirm = useConfirm();
  const t = adminText[locale];
  return <Panel title={t.providersTitle}><div className="provider-groups">{providerCredentialOrder.map((provider) => {
    const items = values.filter((credential) => credential.provider === provider);
    return <section className="provider-group" key={provider}>
      <header className="provider-group-header"><div className="provider-group-title"><span className="provider-group-icon" aria-hidden="true"><KeyRound size={18} /></span><div><h3>{providerLabel(locale, provider)}</h3><span className={`provider-key-count${items.length ? '' : ' is-empty'}`}>{providerCredentialCount(locale, items.length)}</span></div></div><button type="button" className="secondary-action" disabled={busy} onClick={() => openProvider(provider)}><Plus size={14} aria-hidden="true" />{t.addKey}</button></header>
      {items.length ? <div className="provider-key-list">{items.map((item) => <CredentialRowCompact key={item.id} item={item} locale={locale} reveal={reveal} actions={(credential) => <><button type="button" className="provider-action" title={t.edit} aria-label={t.edit} disabled={busy} onClick={() => openEditor(credential)}><Pencil size={14} aria-hidden="true" /></button><button type="button" className="provider-action" title={credential.enabled ? t.stop : t.enable} aria-label={credential.enabled ? t.stop : t.enable} disabled={busy} onClick={() => void mutate(`/providers/${credential.id}`, 'PUT', { enabled: !credential.enabled }, credential.enabled ? t.stop : t.enable)}><Power size={14} aria-hidden="true" /></button><button type="button" className="provider-action" title={t.test} aria-label={t.test} disabled={busy} onClick={() => void mutate(`/providers/${credential.id}/test`, 'POST', undefined, t.testSuccess)}><FlaskConical size={14} aria-hidden="true" /></button><button type="button" className="provider-action danger" title={t.remove} aria-label={t.remove} disabled={busy} onClick={async () => { if (await confirm(credentialRemovalPrompt(locale, credential.label))) void mutate(`/providers/${credential.id}`, 'DELETE', undefined, t.remove); }}><Trash2 size={14} aria-hidden="true" /></button></>} />)}</div> : <div className="provider-empty-state"><KeyRound size={15} aria-hidden="true" /><span>{t.noKeys}</span></div>}
    </section>;
  })}</div></Panel>;
};

function ProviderTestDialog({ credential, locale, request, close, refresh }: {
  credential: Credential; locale: AdminLocale; request: RequestData; close: () => void; refresh: () => void;
}) {
  const t = adminText[locale];
  const text = localeText[locale].test;
  const [mode, setMode] = useState<'chat' | 'translate'>('chat');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OpenAICompatibleDiagnostic | null>(null);
  const [failure, setFailure] = useState('');
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const label = credentialDisplayLabel(locale, credential.label);
  const run = useCallback(async (selected: 'chat' | 'translate') => {
    setRunning(true); setResult(null); setFailure('');
    try {
      setResult(await request<OpenAICompatibleDiagnostic>(`/providers/${credential.id}/diagnose`, { method: 'POST', body: JSON.stringify({ mode: selected }) }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
      refreshRef.current();
    }
  }, [credential.id, request]);
  const started = useRef(false);
  useEffect(() => { if (!started.current) { started.current = true; void run('chat'); } }, [run]);
  const stepLabel = (key: string) => text.steps[key as keyof typeof text.steps] || key;
  return <Dialog title={text.title} close={close} locale={locale} className="provider-test-dialog">
    <div className="dialog-form">
      <div className="test-target"><span className="provider-group-icon" aria-hidden="true"><FlaskConical size={18} /></span><div><strong>{label}</strong><small>{credential.openAICompatible?.model || providerLabel(locale, credential.provider)}</small></div><span className={`badge ${credential.status}`}>{t.status[credential.status as keyof typeof t.status] || credential.status}</span></div>
      <label><span>{text.mode}</span><select value={mode} disabled={running} onChange={(event) => setMode(event.target.value as 'chat' | 'translate')}>
        <option value="chat">{text.modeChat}</option><option value="translate">{text.modeTranslate}</option>
      </select></label>
      <div className="test-console" role="log" aria-live="polite" aria-busy={running}>
        <p className="info">{text.start}: {label}</p>
        {result?.steps.map((step, index) => <p key={`${step.key}-${index}`} className={step.kind}><span>{stepLabel(step.key)}{step.detail !== undefined ? ':' : ''}</span>{step.detail !== undefined && <code>{step.detail}</code>}</p>)}
        {running && <p className="info is-running"><RefreshCw size={13} className="is-spinning" aria-hidden="true" />{text.running}</p>}
        {result && <footer className={result.success ? 'success' : 'error'}>{result.success ? `✓ ${text.passed}` : `✗ ${text.failed}${result.code ? ` · ${result.code}` : ''}`}</footer>}
        {failure && <footer className="error">✗ {failure}</footer>}
      </div>
      <div className="test-meta"><span>{text.model}: {credential.openAICompatible?.model || '-'}</span><span>{text.prompt}: {mode === 'chat' ? '"hi"' : text.addressSample}</span></div>
      <div className="dialog-actions"><button type="button" onClick={close}>{t.close}</button><button type="button" className="primary-action" disabled={running} onClick={() => void run(mode)}><RefreshCw size={15} aria-hidden="true" />{text.retry}</button></div>
    </div>
  </Dialog>;
}
