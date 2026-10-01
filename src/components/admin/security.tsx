import { useEffect, useRef, useState } from 'react';
import { Braces } from 'lucide-react';
import { adminText, blacklistCategoryLabels, dateInputValue, dateTime, generateTokenValue, scopeLabel } from './text';
import { localeText } from './locale-text';
import type { AdminLocale, ApiTokenView, BlacklistViewData, Mutate, Reveal } from './types';
import { Dialog, EmptyState, Panel, SecretCell, SecretInput } from './ui';

export function BlacklistSettings({ value, locale, busy, mutate }: { value: BlacklistViewData; locale: AdminLocale; busy: boolean; mutate: Mutate }) {
  const t = adminText[locale];
  const [keywords, setKeywords] = useState(value.keywords.join('\n'));
  const serverKeywords = useRef(value.keywords.join('\n'));
  useEffect(() => {
    const previous = serverKeywords.current;
    serverKeywords.current = value.keywords.join('\n');
    setKeywords((current) => current === previous ? serverKeywords.current : current);
  }, [value.keywords.join('\n')]);
  return <Panel title={t.blacklistTitle}>
    <div className="blacklist-settings">
      <p>{t.blacklistDescription}</p>
      <section><h3>{t.builtinRules}</h3><div className="blacklist-rule-list">{value.builtIn.map((rule) => <details key={rule.category}>
        <summary>{blacklistCategoryLabels[locale][rule.category] || rule.category}<span>{rule.terms.length}</span></summary>
        <p>{rule.terms.join(' · ')}</p>
      </details>)}</div></section>
      <form onSubmit={async (event) => {
        event.preventDefault();
        const values = keywords.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
        const result = await mutate<Pick<BlacklistViewData, 'keywords'>>('/settings/blacklist', 'PUT', { keywords: values }, t.blacklistSaved);
        if (result) setKeywords((current) => current === keywords ? result.keywords.join('\n') : current);
      }}><label><span>{t.customKeywords}</span><textarea value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder={t.noCustomKeywords} /></label><small>{t.customKeywordHint}</small><button className="primary-action" disabled={busy}>{t.saveBlacklist}</button></form>
    </div>
  </Panel>;
}
export function AccessSettingsForm({ value, locale, busy, mutate }: { value?: { frontendPasswordEnabled?: boolean; passwordChangeRequired?: boolean }; locale: AdminLocale; busy: boolean; mutate: Mutate }) {
  const t = adminText[locale];
  const [passwordDialog, setPasswordDialog] = useState<'frontend' | 'admin' | null>(null);
  return <><form className="admin-form" onSubmit={async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutate('/settings/access', 'PUT', { frontendPasswordEnabled: values.get('frontendPasswordEnabled') === 'on' }, t.settingsSaved);
  }}>
    {value?.passwordChangeRequired && <div className="admin-warning" role="alert">{localeText[locale].ui.defaultPasswordWarning}</div>}
    <div className="setting-group"><h3>{t.policySection}</h3><label className="check"><input name="frontendPasswordEnabled" type="checkbox" defaultChecked={value?.frontendPasswordEnabled} />{t.frontendPasswordEnabled}</label></div>
    <div className="setting-group"><h3>{t.passwordSection}</h3><div className="password-action-list"><div className="password-action-row"><div><strong>{t.newFrontendPassword}</strong><small>{t.keepUnchanged}</small></div><button type="button" disabled={busy} onClick={() => setPasswordDialog('frontend')}>{t.changeFrontendPassword}</button></div><div className="password-action-row"><div><strong>{t.newAdminPassword}</strong><small>{t.keepUnchanged}</small></div><button type="button" disabled={busy} onClick={() => setPasswordDialog('admin')}>{t.changeAdminPassword}</button></div></div></div>
    <button className="primary-action form-submit" disabled={busy}>{t.saveSettings}</button>
  </form>{passwordDialog && <PasswordDialog kind={passwordDialog} locale={locale} busy={busy} mutate={mutate} close={() => setPasswordDialog(null)} />}</>;
}
export function PasswordDialog({ kind, locale, busy, mutate, close }: { kind: 'frontend' | 'admin'; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void }) {
  const t = adminText[locale];
  const [showNew, setShowNew] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [formError, setFormError] = useState('');
  const title = kind === 'frontend' ? t.changeFrontendPassword : t.changeAdminPassword;
  return <Dialog title={title} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const password = String(values.get('password') || '');
    const confirmation = String(values.get('confirmation') || '');
    if (password !== confirmation) { setFormError(t.passwordMismatch); return; }
    setFormError('');
    const body = kind === 'frontend'
      ? { frontendPassword: password, frontendPasswordConfirmation: confirmation }
      : { adminPassword: password, adminPasswordConfirmation: confirmation };
    if (await mutate('/settings/access', 'PUT', body, t.settingsSaved)) close();
  }}>
    <p className="dialog-hint">{t.passwordDialogHint}</p>
    <SecretInput label={t.passwordNew} name="password" visible={showNew} toggle={() => setShowNew((current) => !current)} locale={locale} required />
    <SecretInput label={t.passwordConfirm} name="confirmation" visible={showConfirmation} toggle={() => setShowConfirmation((current) => !current)} locale={locale} required />
    {formError && <p className="field-error" role="alert">{formError}</p>}
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.savePassword}</button></div>
  </form></Dialog>;
}
export const scopesForForm = (scopes: string[] | undefined): string[] => {
  if (!scopes?.length || scopes.includes('*')) return ['read', 'generate'];
  return scopes.filter((scope) => scope === 'read' || scope === 'generate');
};
export const scopesForApi = (scopes: string[]): string[] => scopes.includes('read') && scopes.includes('generate') ? ['*'] : scopes.length ? scopes : ['*'];
export function ScopePicker({ locale, value, onChange }: { locale: AdminLocale; value: string[]; onChange: (value: string[]) => void }) {
  const t = adminText[locale];
  const toggle = (scope: 'read' | 'generate', enabled: boolean) => {
    const next = new Set(value);
    if (enabled) next.add(scope); else next.delete(scope);
    onChange([...next]);
  };
  const all = value.includes('read') && value.includes('generate');
  return <fieldset className="scope-picker"><legend>{t.scopes}</legend><div className="scope-options"><label className="check"><input type="checkbox" checked={all} onChange={(event) => onChange(event.target.checked ? ['read', 'generate'] : [])} />{t.scopeAll}</label><label className="check"><input type="checkbox" checked={value.includes('read')} onChange={(event) => toggle('read', event.target.checked)} />{t.scopeRead}</label><label className="check"><input type="checkbox" checked={value.includes('generate')} onChange={(event) => toggle('generate', event.target.checked)} />{t.scopeGenerate}</label></div><small>{t.scopeHint}</small></fieldset>;
}
export function TokenEditorDialog({ mode, value, locale, busy, mutate, close, created }: { mode: 'create' | 'edit'; value?: ApiTokenView; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void; created: (token: string) => void }) {
  const t = adminText[locale];
  const [name, setName] = useState(value?.name || '');
  const [tokenValue, setTokenValue] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [rateLimit, setRateLimit] = useState(String(value?.rate_limit_per_minute || 60));
  const [expiresAt, setExpiresAt] = useState(dateInputValue(value?.expires_at));
  const [scopes, setScopes] = useState(scopesForForm(value?.scopes));
  const isCreate = mode === 'create';
  return <Dialog title={isCreate ? t.tokenDialog : t.editTokenDialog} close={close} locale={locale}><form className="dialog-form token-editor-form" onSubmit={async (event) => {
    event.preventDefault();
    const expiry = expiresAt ? new Date(expiresAt).toISOString() : null;
    const body = isCreate
      ? { name: name.trim(), token: tokenValue.trim() || undefined, scopes: scopesForApi(scopes), rateLimit: Number(rateLimit), expiresAt: expiry }
      : { scopes: scopesForApi(scopes), rateLimit: Number(rateLimit), expiresAt: expiry };
    const result = await mutate<{ id: string; token?: string }>(isCreate ? '/tokens' : `/tokens/${value?.id}`, isCreate ? 'POST' : 'PUT', body, isCreate ? '' : t.tokenUpdated);
    if (!result) return;
    if (isCreate) created(String(result.token || '')); else close();
  }}>
    {isCreate ? <label><span>{t.name}</span><input name="name" value={name} required onChange={(event) => setName(event.target.value)} /></label> : <div className="dialog-readonly"><span>{t.name}</span><b>{value?.name}</b></div>}
    {isCreate && <label className="secret-input-field"><span>{t.tokenValue}</span><div><input name="token" type={showToken ? 'text' : 'password'} value={tokenValue} placeholder={t.tokenValueHint} autoComplete="off" onChange={(event) => setTokenValue(event.target.value)} /><button type="button" className="inline-toggle" onClick={() => setShowToken((current) => !current)}>{showToken ? t.hidePassword : t.showPassword}</button></div><small>{t.tokenValueHint}</small></label>}
    {isCreate && <button type="button" className="secondary-action generate-token-button" onClick={() => { setTokenValue(generateTokenValue()); setShowToken(true); }}>{t.generateToken}</button>}
    <ScopePicker locale={locale} value={scopes} onChange={setScopes} />
    <label><span>{t.perMinute}</span><input name="rateLimit" type="number" min="1" max="100000" required value={rateLimit} onChange={(event) => setRateLimit(event.target.value)} /></label>
    <label><span>{t.expires}</span><input name="expiresAt" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /><small>{t.neverExpires}</small></label>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{isCreate ? t.create : t.update}</button></div>
  </form></Dialog>;
}
export function TokenSecretDialog({ value, locale, close }: { value: string; locale: AdminLocale; close: () => void }) {
  const t = adminText[locale];
  const [visible, setVisible] = useState(true);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); }
  };
  return <Dialog title={t.tokenCreatedTitle} close={close} locale={locale}><div className="token-secret-dialog"><p>{t.tokenCreatedHint}</p><code>{visible ? value : '••••••••••••'}</code><div className="secret-actions"><button type="button" className="compact-action" onClick={() => setVisible((current) => !current)}>{visible ? t.hideSecret : t.showSecret}</button><button type="button" className="compact-action" onClick={() => void copy()}>{copied ? t.copied : t.copySecret}</button></div><div className="dialog-actions"><button type="button" className="primary-action" onClick={close}>{t.close}</button></div></div></Dialog>;
}
export const TokenTable = ({ values, locale, reveal, edit, revoke }: { values: ApiTokenView[]; locale: AdminLocale; reveal: Reveal; edit: (value: ApiTokenView) => void; revoke: (id: string) => void }) => { const t = adminText[locale]; return <div className="table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.tokenValue}</th><th>{t.scopes}</th><th>{t.perMinute}</th><th>{t.expires}</th><th>{t.actions}</th></tr></thead><tbody>{values.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.token_revealable ? <SecretCell mask={item.token_mask} locale={locale} reveal={reveal} path={`/tokens/${item.id}/reveal`} field="token" /> : <span className="token-unavailable">{t.tokenUnavailable}</span>}</td><td>{item.scopes.map((scope) => scopeLabel(String(scope), locale)).join(localeText[locale].ui.listSeparator)}</td><td>{item.rate_limit_per_minute.toLocaleString()}</td><td>{item.expires_at ? dateTime(item.expires_at, locale) : t.neverExpires}</td><td className="row-actions"><button type="button" disabled={Boolean(item.revoked_at)} onClick={() => edit(item)}>{t.edit}</button><button type="button" className="danger" disabled={Boolean(item.revoked_at)} onClick={() => revoke(item.id)}>{item.revoked_at ? t.revoked : t.revoke}</button></td></tr>)}</tbody></table>{!values.length && <EmptyState icon={Braces} text={t.noTokens} />}</div>; };
