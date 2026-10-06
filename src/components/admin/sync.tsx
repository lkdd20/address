import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type SyntheticEvent } from 'react';
import { ChevronLeft, ChevronRight, Database, MapPin, RefreshCw, Search } from 'lucide-react';
import { isCountryCode } from '../../domain/countries';
import { localizedCountryName } from '../../domain/locales';
import { localeText } from './locale-text';
import { addressDataText, adminText, coverageLevels, dateTime, durationLabel, errorMessage, flagSrc, interpolate, queueBadgeClass, queueExtraStateText, queueReasonText, queueStateRank, remainingTime, syncHistoryResultDetail, syncHistoryStatusClass, syncInterrupted, syncHistoryText, syncQueueRuleText, usagePercent } from './text';
import type { AddressDataCountry, AddressDataWorkspace, AddressNodeTarget, AdminLocale, ChinaAreaListData, Mutate, RequestData, SyncHistoryData, SyncQueueData, SyncQueueEntry, SyncQueueGoalLevel, SyncQueueRules } from './types';
import { EmptyState, usePolling } from './ui';

export function ChinaAreaCoverage({ locale, request }: { locale: AdminLocale; request: RequestData }) {
  const t = adminText[locale];
  const [provinceAdcode, setProvinceAdcode] = useState('');
  const [cityAdcode, setCityAdcode] = useState('');
  const [districtAdcode, setDistrictAdcode] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<ChinaAreaListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (provinceAdcode) parameters.set('provinceAdcode', provinceAdcode);
    if (cityAdcode) parameters.set('cityAdcode', cityAdcode);
    if (districtAdcode) parameters.set('districtAdcode', districtAdcode);
    setLoading(true); setError('');
    void request<ChinaAreaListData>(`/china/areas?${parameters}`, { signal: controller.signal })
      .then((value) => {
        const pages = Math.max(1, Math.ceil(value.total / value.pageSize));
        if (page > pages) { setPage(pages); return; }
        setData(value);
      })
      .catch((value) => { if (!controller.signal.aborted) setError(errorMessage(value, locale)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, locale, provinceAdcode, cityAdcode, districtAdcode, page, pageSize]);
  const pages = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || pageSize)));
  const changeProvince = (value: string) => { setProvinceAdcode(value); setCityAdcode(''); setDistrictAdcode(''); setPage(1); };
  const changeCity = (value: string) => { setCityAdcode(value); setDistrictAdcode(''); setPage(1); };
  return <>
    <div className="coverage-filters">
      <label><span>{t.province}</span><select value={provinceAdcode} onChange={(event) => changeProvince(event.target.value)}><option value="">{t.allProvinces}</option>{data?.options.provinces.map((item) => <option key={item.adcode} value={item.adcode}>{item.name}</option>)}</select></label>
      <label><span>{t.city}</span><select value={cityAdcode} disabled={!provinceAdcode} onChange={(event) => changeCity(event.target.value)}><option value="">{t.allCities}</option>{data?.options.cities.map((item) => <option key={item.adcode} value={item.adcode}>{item.name}</option>)}</select></label>
      <label><span>{t.district}</span><select value={districtAdcode} disabled={!cityAdcode} onChange={(event) => { setDistrictAdcode(event.target.value); setPage(1); }}><option value="">{t.allDistricts}</option>{data?.options.districts.map((item) => <option key={item.adcode} value={item.adcode}>{item.name}</option>)}</select></label>
      <label><span>{t.pageSize}</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>{[25, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    </div>
    {error && <div className="table-error" role="alert">{error}</div>}
    <div className={`table-scroll coverage-table${loading ? ' is-loading' : ''}`}><table><thead><tr><th>{t.province}</th><th>{t.city}</th><th>{t.district}</th><th>{t.currentCommunities}</th><th>{t.target}</th><th>{t.statusLabel}</th></tr></thead><tbody>{(data?.items || []).map((item) => { const current = Number(item.current_count || 0); const target = Number(item.target_count || 5); return <tr key={String(item.district_adcode)}><td>{String(item.province)}</td><td>{String(item.city)}</td><td>{String(item.district)}</td><td>{current.toLocaleString()}</td><td>{target.toLocaleString()}</td><td><span className={`badge ${current >= target ? 'succeeded' : ''}`}>{current >= target ? t.covered : t.pending}</span></td></tr>; })}</tbody></table>{!loading && !data?.items.length && <EmptyState icon={MapPin} text={t.noAreas} />}</div>
    <div className="table-pagination"><span>{interpolate(t.pageSummary, { page, pages, total: data?.total || 0 })}</span><div><button disabled={loading || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t.previousPage}</button><button disabled={loading || page >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}>{t.nextPage}</button></div></div>
  </>;
}
const emptyHistory: SyncHistoryData = { scheduler: null, items: [], limit: 50 };
export function SyncHistoryPanel({ initialData, locale, request, fixedCountry = '' }: { initialData: SyncHistoryData; locale: AdminLocale; request: RequestData; fixedCountry?: string }) {
  const text = syncHistoryText[locale];
  const [data, setData] = useState<SyncHistoryData>(initialData);
  const [selectedCountry, setCountry] = useState('');
  const country = fixedCountry || selectedCountry;
  const [offset, setOffset] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setData(initialData); setOffset(0);
  }, [initialData]);
  usePolling(async (signal) => {
    try {
      const params = new URLSearchParams({ limit: String(data.limit || 100), offset: String(offset) });
      if (country) params.set('country', country);
      const value = await request<SyncHistoryData>(`/sync/history?${params.toString()}`, { signal });
      if (!signal.aborted) { setData(value); setFailed(false); }
    } catch {
      if (!signal.aborted) setFailed(true);
    }
  }, 15_000, [country, data.limit, offset, request], true);
  const countries = [...new Set([
    ...(initialData.countries || []), ...(data.countries || []),
    ...data.items.map((item) => item.countryCode).filter((value): value is string => Boolean(value))
  ])].sort();
  const statusLabel = (status: string): string => text[status as keyof typeof text] || status;
  return <section className="admin-panel sync-history-panel">
    <header><h2>{text.title}</h2>{!fixedCountry && <div className="sync-history-toolbar">
      <label><span className="sr-only">{text.country}</span><select value={country} onChange={(event) => { setCountry(event.target.value); setOffset(0); }}>
        <option value="">{text.allCountries}</option>{countries.map((code) => <option key={code} value={code}>{isCountryCode(code) ? localizedCountryName(code, locale, code) : code}</option>)}
      </select></label>
    </div>}</header>
    <div className="sync-history-summary"><span className={`badge address-data-status ${data.scheduler?.active_run_id ? 'running' : 'ready'}`}>{data.scheduler?.active_run_id ? text.schedulerActive : text.schedulerIdle}</span><span>{text.lastHeartbeat}: {dateTime(data.scheduler?.heartbeat_at, locale)}</span>{failed && <span className="queue-unavailable">{addressDataText[locale].queueUnavailable}</span>}</div>
    {data.items.length ? <div className="table-scroll"><table className="sync-history-table"><thead><tr><th>{text.status}</th><th>{text.country}</th><th>{text.source}</th><th>{text.period}</th><th>{text.duration}</th><th>{text.growth}</th><th>{text.details}</th></tr></thead><tbody>{data.items.map((item, index) => {
      const name = item.countryCode && isCountryCode(item.countryCode) ? localizedCountryName(item.countryCode, locale, item.countryCode) : item.countryCode || '-';
      const ended = item.completedAt || new Date().toISOString();
      return <tr key={`${item.id}-${item.countryCode || ''}-${item.sourceId}-${index}`}>
        <td><span className={`badge address-data-status ${syncHistoryStatusClass(item.status, item.errorCode)}`}>{syncInterrupted(item) ? text.interrupted : statusLabel(item.status)}</span></td>
        <td><span className="country-cell-name"><strong>{name}</strong>{item.countryCode && <small className="country-code">{item.countryCode}</small>}</span></td>
        <td>{item.sourceId || (item.kind.startsWith('china') ? 'China map providers' : '-')}</td>
        <td><span className="history-period">{dateTime(item.startedAt || item.createdAt, locale)}<b>→</b>{dateTime(ended, locale)}</span></td>
        <td>{durationLabel(item.startedAt, item.completedAt, locale)}</td>
        <td className={(item.netGrowth || 0) > 0 ? 'history-growth-positive' : ''}>{item.netGrowth === null ? '-' : <>{item.netGrowth > 0 ? '+' : ''}{item.netGrowth.toLocaleString(locale)}</>}</td>
        <td title={syncHistoryResultDetail(item, locale)}>{syncHistoryResultDetail(item, locale) || '-'}</td>
      </tr>;
    })}</tbody></table></div> : <p className="admin-empty">{text.empty}</p>}
    {(offset > 0 || data.hasMore) && <footer className="sync-history-pagination">
      <button type="button" className="icon-button" title={text.previous} aria-label={text.previous} disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - (data.limit || 100)))}><ChevronLeft size={16} /></button>
      <span>{Math.floor(offset / (data.limit || 100)) + 1}</span>
      <button type="button" className="icon-button" title={text.next} aria-label={text.next} disabled={!data.hasMore} onClick={() => setOffset(data.nextOffset ?? offset + (data.limit || 100))}><ChevronRight size={16} /></button>
    </footer>}
  </section>;
}
type WorkspaceFilter = 'all' | 'attention' | 'active' | 'waiting' | 'done' | 'limited';
type WorkspaceSort = 'deficit' | 'name' | 'coverage';
type DetailTab = 'overview' | 'targets' | 'nodes' | 'sources' | 'history' | 'china';
const workspaceFilterStates: Record<Exclude<WorkspaceFilter, 'all'>, string[]> = {
  attention: ['failed', 'blocked', 'suspended', 'no_source'],
  active: ['running', 'queued', 'below_target'],
  waiting: ['retry_wait', 'cooldown_wait', 'quota_wait', 'scheduled_wait'],
  done: ['done', 'ready'],
  limited: ['source_limited']
};
const countryFromLocation = (): string | null => {
  if (typeof window === 'undefined') return null;
  const value = new URL(window.location.href).searchParams.get('country')?.toUpperCase() || '';
  return /^[A-Z]{2}$/u.test(value) ? value : null;
};
const countryName = (countryCode: string, locale: AdminLocale): string =>
  isCountryCode(countryCode) ? localizedCountryName(countryCode, locale, countryCode) : countryCode;
const rowState = (country: AddressDataCountry, entry?: SyncQueueEntry): string => entry?.state || country.status;
const stateBadgeClass = (country: AddressDataCountry, entry?: SyncQueueEntry): string => entry ? queueBadgeClass[entry.state] : country.status;
const stateLabel = (state: string, locale: AdminLocale): string => {
  const text = addressDataText[locale];
  if (state === 'queued') return text.queueQueued;
  if (state === 'done') return text.states.ready;
  const extras = queueExtraStateText(locale);
  if (state in extras) return extras[state as keyof typeof extras];
  return text.states[state] || state;
};
export const administrativeCoverage = (country: AddressDataCountry): number => country.lowestCoverage?.total
  ? country.lowestCoverage.covered / country.lowestCoverage.total : country.coverageActual;
const coverageDetail = (country: AddressDataCountry, locale: AdminLocale): string => {
  const coverage = country.lowestCoverage;
  if (!coverage?.total) return '';
  const ui = localeText[locale].ui;
  return [interpolate(ui.coverageNodes, { covered: coverage.covered.toLocaleString(locale), total: coverage.total.toLocaleString(locale) }),
    interpolate(ui.minimumNodes, { count: coverage.qualified.toLocaleString(locale), min: country.minPerNode.toLocaleString(locale) })].join(' · ');
};
export const rulesFor = (country: AddressDataCountry, entry?: SyncQueueEntry): SyncQueueRules => {
  if (entry?.rules) return entry.rules;
  const administrativeCoverageMet = entry?.unmetRules
    ? !entry.unmetRules.some((rule) => ['coverage', 'administrative_coverage'].includes(rule)) : country.coverageMet;
  const regionalMinimumsMet = entry?.unmetRules
    ? !entry.unmetRules.some((rule) => ['coverage', 'node_overrides', 'regional_minimums'].includes(rule)) : country.coverageMet;
  return {
    total: { current: country.currentCount, target: country.targetCount, met: country.countMet },
    administrativeCoverage: {
      actual: administrativeCoverage(country), target: country.coverageRatio, met: administrativeCoverageMet,
      covered: country.lowestCoverage?.covered || 0, total: country.lowestCoverage?.total || 0
    },
    regionalMinimums: {
      actual: regionalMinimumsMet ? 1 : 0, target: 1, met: regionalMinimumsMet,
      lowest: null, level1: null, level2: null, overrides: { satisfied: 0, total: 0, met: true }
    }
  };
};
const nextRunLabel = (value: string | null | undefined, locale: AdminLocale): string => {
  const at = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) return '-';
  return at <= Date.now() ? localeText[locale].ui.nextRunPending : dateTime(value, locale);
};
const queueNote = (entry: SyncQueueEntry | undefined, country: AddressDataCountry, locale: AdminLocale, job: SyncQueueData['job']): string => {
  const text = addressDataText[locale];
  const ui = localeText[locale].ui;
  if (!entry) return queueReasonText(country.lastError, locale);
  const eta = entry.eta ? (() => {
    const median = Math.max(1, Math.ceil((entry.eta.remainingMedianMs ?? entry.eta.medianMs) / 60_000));
    const p80 = Math.max(median, Math.ceil((entry.eta.remainingP80Ms ?? entry.eta.p80Ms) / 60_000));
    return `${ui.eta} P50 ${median}m · P80 ${p80}m · n=${entry.eta.sampleCount}`;
  })() : '';
  if (entry.state === 'running') return [entry.jobPhase || job?.phase || '', eta].filter(Boolean).join(' · ');
  if (entry.state === 'queued') return [entry.position ? `#${entry.position}` : '', eta].filter(Boolean).join(' · ');
  if (entry.state === 'quota_wait') {
    return [queueReasonText(entry.reason, locale), entry.nextAttemptAt ? interpolate(text.queueResetIn, { time: remainingTime(entry.nextAttemptAt) }) : ''].filter(Boolean).join(' · ');
  }
  if (['retry_wait', 'cooldown_wait', 'scheduled_wait'].includes(entry.state)) {
    return [queueReasonText(entry.reason, locale), entry.nextAttemptAt ? interpolate(ui.untilRetry, { time: remainingTime(entry.nextAttemptAt) }) : ''].filter(Boolean).join(' · ');
  }
  return queueReasonText(entry.reason || country.lastError, locale);
};

function RuleBadges({ rules, locale }: { rules: SyncQueueRules; locale: AdminLocale }) {
  const ruleText = syncQueueRuleText[locale];
  const ui = localeText[locale].ui;
  const items: Array<[string, boolean, string]> = [
    [ui.ruleTotal, rules.total.met, `${ruleText.total}: ${rules.total.current.toLocaleString(locale)} / ${rules.total.target.toLocaleString(locale)}`],
    [ui.ruleCoverage, rules.administrativeCoverage.met, `${ruleText.coverage}: ${Math.round(rules.administrativeCoverage.actual * 100)}% / ${Math.round(rules.administrativeCoverage.target * 100)}%`],
    [ui.ruleMinimum, rules.regionalMinimums.met, `${ruleText.minimums}: ${Math.round(rules.regionalMinimums.actual * 100)}% / ${Math.round(rules.regionalMinimums.target * 100)}%`]
  ];
  return <div className="rule-badges">{items.map(([label, met, detail]) => <span key={label} className={`badge target-state ${met ? 'met' : 'below_target'}`} title={detail}>{label}</span>)}</div>;
}

export function CountryWorkspace({ initialData, locale, busy, mutate, request }: {
  initialData: AddressDataWorkspace; locale: AdminLocale; busy: boolean; mutate: Mutate; request: RequestData;
}) {
  const text = addressDataText[locale];
  const ui = localeText[locale].ui;
  const t = adminText[locale];
  const [data, setData] = useState(initialData);
  const [selected, setSelected] = useState<string | null>(countryFromLocation);
  const [filter, setFilter] = useState<WorkspaceFilter>('all');
  const [sort, setSort] = useState<WorkspaceSort>('deficit');
  const [query, setQuery] = useState('');
  useEffect(() => setData(initialData), [initialData]);
  usePolling(async (signal) => {
    const [countries, queue] = await Promise.all([
      request<AddressDataCountry[]>('/address-data', { signal }),
      request<SyncQueueData>('/sync/queue', { signal }).catch(() => null)
    ]);
    if (!signal.aborted) setData({ countries, queue });
  }, 15_000, [request]);
  useEffect(() => {
    const restore = () => setSelected(countryFromLocation());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const open = (code: string | null) => {
    const url = new URL(window.location.href);
    if (code) url.searchParams.set('country', code); else url.searchParams.delete('country');
    window.history.pushState({}, '', url);
    setSelected(code);
    window.scrollTo({ top: 0 });
  };
  const entries = useMemo(() => new Map((data.queue?.entries || []).map((entry) => [entry.countryCode, entry])), [data.queue]);
  const counts = useMemo(() => {
    const value: Record<WorkspaceFilter, number> = { all: data.countries.length, attention: 0, active: 0, waiting: 0, done: 0, limited: 0 };
    for (const country of data.countries) {
      const state = rowState(country, entries.get(country.countryCode));
      for (const [key, states] of Object.entries(workspaceFilterStates)) if (states.includes(state)) value[key as WorkspaceFilter] += 1;
    }
    return value;
  }, [data.countries, entries]);
  const needle = query.trim().toLocaleLowerCase();
  const rows = data.countries.filter((country) => {
    const state = rowState(country, entries.get(country.countryCode));
    if (filter !== 'all' && !workspaceFilterStates[filter].includes(state)) return false;
    return !needle || country.countryCode.toLowerCase().includes(needle) || countryName(country.countryCode, locale).toLocaleLowerCase().includes(needle);
  }).sort((left, right) => {
    if (sort === 'name') return countryName(left.countryCode, locale).localeCompare(countryName(right.countryCode, locale), locale);
    if (sort === 'coverage') return administrativeCoverage(left) - administrativeCoverage(right) || left.countryCode.localeCompare(right.countryCode);
    return Number(left.countryCode !== 'CN') - Number(right.countryCode !== 'CN')
      || (queueStateRank[(entries.get(left.countryCode)?.state || 'done')] - queueStateRank[(entries.get(right.countryCode)?.state || 'done')])
      || right.deficit - left.deficit || left.countryCode.localeCompare(right.countryCode);
  });
  const sync = (countryCode: string) => void mutate(`/address-data/${countryCode}/sync`, 'POST', undefined, text.syncStarted);
  if (selected) {
    const country = data.countries.find((item) => item.countryCode === selected);
    if (!country) return <section className="admin-panel"><header><button type="button" className="secondary-action" onClick={() => open(null)}><ChevronLeft size={15} aria-hidden="true" />{ui.backToList}</button></header><p className="admin-empty">{ui.notFound}</p></section>;
    return <CountryDetail country={country} entry={entries.get(country.countryCode)} job={data.queue?.job || null} locale={locale} busy={busy} mutate={mutate} request={request} back={() => open(null)} sync={() => sync(country.countryCode)} />;
  }
  const filters: WorkspaceFilter[] = ['all', 'attention', 'active', 'waiting', 'done', 'limited'];
  const filterLabels: Record<WorkspaceFilter, string> = {
    all: ui.filterAll, attention: ui.filterAttention, active: ui.filterActive, waiting: ui.filterWaiting, done: ui.filterDone, limited: ui.filterLimited
  };
  return <section className="address-data-page">
    <header className="workspace-toolbar">
      <div className="segmented-filter" role="group" aria-label={t.filter}>{filters.map((item) => <button type="button" key={item} className={filter === item ? 'active' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)}>{filterLabels[item]}<span>{counts[item]}</span></button>)}</div>
      <div className="country-table-tools">
        <label className="country-search"><Search size={14} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.searchCountry} aria-label={t.searchCountry} /></label>
        <select aria-label={ui.sortLabel} value={sort} onChange={(event) => setSort(event.target.value as WorkspaceSort)}>
          <option value="deficit">{ui.sortDeficit}</option><option value="name">{ui.sortName}</option><option value="coverage">{ui.sortCoverage}</option>
        </select>
      </div>
    </header>
    {data.queue && !data.queue.available && <p className="queue-unavailable" role="status">{data.queue.generatedAt ? interpolate(ui.queueStale, { time: dateTime(data.queue.generatedAt, locale) }) : text.queueUnavailable}</p>}
    {!data.queue && <p className="queue-unavailable" role="status">{text.queueUnavailable}</p>}
    {data.queue?.job && !data.queue.entries.some((entry) => entry.state === 'running') && <p className="queue-job-note">{text.states.running} · {data.queue.job.id} · {data.queue.job.phase}</p>}
    <div className="table-scroll address-data-table"><table><thead><tr>
      <th>{text.country}</th><th>{text.current}</th><th>{text.coverage}</th><th>{ui.rulesColumn}</th><th>{text.status}</th><th>{text.nextRun}</th><th><span className="sr-only">{t.actions}</span></th>
    </tr></thead><tbody>{rows.map((country) => {
      const entry = entries.get(country.countryCode);
      const state = rowState(country, entry);
      const note = queueNote(entry, country, locale, data.queue?.job || null);
      const coveragePercent = administrativeCoverage(country);
      const running = state === 'running';
      return <tr key={country.countryCode} className={`queue-row ${state}`} data-country={country.countryCode}>
        <td><button type="button" className="country-name-button" onClick={() => open(country.countryCode)}>{isCountryCode(country.countryCode) && <img className="country-flag" src={flagSrc(country.countryCode)} width="24" height="18" alt="" loading="lazy" />}<span className="country-cell-name"><strong>{countryName(country.countryCode, locale)}</strong><small className="country-code">{country.countryCode}</small></span></button></td>
        <td className="numeric-cell"><div className="count-progress"><strong>{country.currentCount.toLocaleString(locale)}<small> / {country.targetCount.toLocaleString(locale)}</small></strong><span className="progress-track" aria-hidden="true"><i style={{ width: `${usagePercent(country.currentCount, country.targetCount)}%` }} /></span></div></td>
        <td><div className="coverage-cell" title={coverageDetail(country, locale) || undefined}>
          <div className="coverage-cell-head"><strong>{Math.round(coveragePercent * 100)}%</strong><small>/ {Math.round(country.coverageRatio * 100)}%</small></div>
          <span className="progress-track coverage-progress" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round(coveragePercent * 100))}%` }} /><b style={{ left: `calc(${Math.min(100, Math.round(country.coverageRatio * 100))}% - 1px)` }} /></span>
        </div></td>
        <td><RuleBadges rules={rulesFor(country, entry)} locale={locale} /></td>
        <td><div className="state-cell"><span className={`badge address-data-status ${stateBadgeClass(country, entry)}`}>{stateLabel(state, locale)}</span>{note && <small title={note}>{note}</small>}</div></td>
        <td className="next-run-cell">{running ? '-' : nextRunLabel(entry?.nextAttemptAt ?? country.nextAttemptAt, locale)}</td>
        <td className="row-actions"><button type="button" className="icon-action" title={text.sync} aria-label={`${text.sync} ${countryName(country.countryCode, locale)}`} disabled={busy || !country.enabled || running} onClick={() => sync(country.countryCode)}><RefreshCw size={14} aria-hidden="true" /></button><button type="button" onClick={() => open(country.countryCode)}>{text.details}</button></td>
      </tr>;
    })}</tbody></table>{!rows.length && <p className="admin-empty">{text.queueEmpty}</p>}</div>
    {data.queue?.generatedAt && data.queue.available && <small className="queue-done-note">{interpolate(ui.queueFresh, { time: dateTime(data.queue.generatedAt, locale) })}</small>}
  </section>;
}

function CountryDetail({ country, entry, job, locale, busy, mutate, request, back, sync }: {
  country: AddressDataCountry; entry?: SyncQueueEntry; job: SyncQueueData['job']; locale: AdminLocale; busy: boolean;
  mutate: Mutate; request: RequestData; back: () => void; sync: () => void;
}) {
  const text = addressDataText[locale];
  const ui = localeText[locale].ui;
  const t = adminText[locale];
  const ruleText = syncQueueRuleText[locale];
  const [tab, setTab] = useState<DetailTab>('overview');
  const tabs: Array<[DetailTab, string]> = [
    ['overview', ui.tabOverview], ['targets', ui.tabTargets], ['nodes', ui.tabNodes], ['sources', ui.tabSources], ['history', ui.tabHistory],
    ...(country.countryCode === 'CN' ? [['china', ui.tabChina] as [DetailTab, string]] : [])
  ];
  const state = rowState(country, entry);
  const rules = rulesFor(country, entry);
  const note = queueNote(entry, country, locale, job);
  const tabId = (value: DetailTab) => `country-tab-${value}`;
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const index = tabs.findIndex(([value]) => value === tab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  };
  const minimumLevels = ([
    [ruleText.lowest, rules.regionalMinimums.lowest], [ruleText.level1, rules.regionalMinimums.level1], [ruleText.level2, rules.regionalMinimums.level2]
  ] as Array<[string, SyncQueueGoalLevel | null]>).filter((value): value is [string, SyncQueueGoalLevel] => Boolean(value[1]));
  return <section className="country-detail" aria-labelledby="country-detail-title">
    <header className="country-detail-header">
      <button type="button" className="secondary-action" onClick={back}><ChevronLeft size={15} aria-hidden="true" />{ui.backToList}</button>
      <div className="country-detail-title">{isCountryCode(country.countryCode) && <img className="country-flag" src={flagSrc(country.countryCode)} width="32" height="24" alt="" />}<div><h2 id="country-detail-title">{countryName(country.countryCode, locale)}</h2><small className="country-code">{country.countryCode}</small></div><span className={`badge address-data-status ${stateBadgeClass(country, entry)}`}>{stateLabel(state, locale)}</span></div>
      <button type="button" className="primary-action" disabled={busy || !country.enabled || state === 'running'} onClick={sync}><RefreshCw size={15} aria-hidden="true" />{state === 'running' ? text.syncing : text.sync}</button>
    </header>
    <div className="detail-tabs" role="tablist" aria-label={countryName(country.countryCode, locale)} onKeyDown={keyDown}>{tabs.map(([value, label]) => <button type="button" role="tab" key={value} id={tabId(value)} aria-selected={tab === value} aria-controls="country-tab-panel" tabIndex={tab === value ? 0 : -1} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
    <div className="country-tab-panel" id="country-tab-panel" role="tabpanel" aria-labelledby={tabId(tab)}>
      {tab === 'overview' && <div className="detail-overview">
        <article className="detail-stat"><span>{text.current}</span><strong>{country.currentCount.toLocaleString(locale)}</strong><small>{text.target} {country.targetCount.toLocaleString(locale)}</small><span className="progress-track" aria-hidden="true"><i style={{ width: `${usagePercent(country.currentCount, country.targetCount)}%` }} /></span></article>
        <article className="detail-stat"><span>{text.coverage}</span><strong>{Math.round(administrativeCoverage(country) * 100)}%</strong><small>{text.coverageGoal} {Math.round(country.coverageRatio * 100)}%{coverageDetail(country, locale) && ` · ${coverageDetail(country, locale)}`}</small><span className="progress-track coverage-progress" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round(administrativeCoverage(country) * 100))}%` }} /><b style={{ left: `calc(${Math.min(100, Math.round(country.coverageRatio * 100))}% - 1px)` }} /></span></article>
        <article className="detail-stat"><span>{text.nextRun}</span><strong className="detail-stat-text">{nextRunLabel(entry?.nextAttemptAt ?? country.nextAttemptAt, locale)}</strong><small>{text.lastSuccess} {dateTime(country.lastSuccessfulAt, locale)}</small></article>
        <section className="detail-card detail-rules"><h3>{ui.rulesColumn}</h3>
          <dl>
            <div><dt>{ruleText.total}</dt><dd><span className={`badge target-state ${rules.total.met ? 'met' : 'below_target'}`}>{rules.total.met ? ruleText.met : ruleText.unmet}</span>{rules.total.current.toLocaleString(locale)} / {rules.total.target.toLocaleString(locale)}</dd></div>
            <div><dt>{ruleText.coverage}</dt><dd><span className={`badge target-state ${rules.administrativeCoverage.met ? 'met' : 'below_target'}`}>{rules.administrativeCoverage.met ? ruleText.met : ruleText.unmet}</span>{Math.round(rules.administrativeCoverage.actual * 100)}% / {Math.round(rules.administrativeCoverage.target * 100)}%{rules.administrativeCoverage.total > 0 && <small>{rules.administrativeCoverage.covered.toLocaleString(locale)} / {rules.administrativeCoverage.total.toLocaleString(locale)}</small>}</dd></div>
            <div><dt>{ruleText.minimums}</dt><dd><span className={`badge target-state ${rules.regionalMinimums.met ? 'met' : 'below_target'}`}>{rules.regionalMinimums.met ? ruleText.met : ruleText.unmet}</span>{Math.round(rules.regionalMinimums.actual * 100)}% / {Math.round(rules.regionalMinimums.target * 100)}%{minimumLevels.map(([label, level]) => <small key={label}>{label}: {level.qualified.toLocaleString(locale)} / {level.total.toLocaleString(locale)} · ≥{level.minimum.toLocaleString(locale)}</small>)}{rules.regionalMinimums.overrides.total > 0 && <small>{ruleText.overrides}: {rules.regionalMinimums.overrides.satisfied.toLocaleString(locale)} / {rules.regionalMinimums.overrides.total.toLocaleString(locale)}</small>}</dd></div>
          </dl>
        </section>
        <section className="detail-card"><h3>{ui.currentState}</h3><p><span className={`badge address-data-status ${stateBadgeClass(country, entry)}`}>{stateLabel(state, locale)}</span></p>{note && <p className="detail-reason"><b>{ui.stateReason}</b>{note}</p>}{country.pruneCandidates > 0 && <p className="prune-hint">{interpolate(text.prunable, { count: country.pruneCandidates.toLocaleString(locale) })}</p>}</section>
      </div>}
      {tab === 'targets' && <CountryPolicyForm value={country} locale={locale} busy={busy} mutate={mutate} request={request} />}
      {tab === 'nodes' && <AddressNodeTargets countryCode={country.countryCode} locale={locale} request={request} />}
      {tab === 'sources' && <section className="address-source-list">{country.sources.length ? country.sources.map((source) => <article key={source.id}>
        <div><a href={source.homepageUrl} target="_blank" rel="noreferrer">{source.name}</a><small>{source.id}</small></div>
        <dl><div><dt>{text.activeRecords}</dt><dd>{source.activeCount.toLocaleString(locale)}</dd></div><div><dt>{text.latestVersion}</dt><dd>{source.latestVersion || '-'}</dd></div><div><dt>{text.lastImport}</dt><dd>{dateTime(source.latestImportedAt, locale)}</dd></div></dl>
      </article>) : <EmptyState icon={Database} text={text.noSources} />}</section>}
      {tab === 'history' && <SyncHistoryPanel initialData={emptyHistory} fixedCountry={country.countryCode} locale={locale} request={request} />}
      {tab === 'china' && <section className="china-area-detail"><h3>{t.districtCoverage}</h3><ChinaAreaCoverage locale={locale} request={request} /></section>}
    </div>
  </section>;
}

function CountryPolicyForm({ value, locale, busy, mutate, request }: {
  value: AddressDataCountry; locale: AdminLocale; busy: boolean; mutate: Mutate; request: RequestData;
}) {
  const text = addressDataText[locale];
  const [enabled, setEnabled] = useState(value.enabled);
  const [target, setTarget] = useState(String(value.targetCount));
  const [minPerNode, setMinPerNode] = useState(String(value.minPerNode));
  const [coveragePercent, setCoveragePercent] = useState(String(Math.round(value.coverageRatio * 100)));
  const [level1Min, setLevel1Min] = useState(String(value.level1Min));
  const [level2Min, setLevel2Min] = useState(String(value.level2Min));
  const [policyError, setPolicyError] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPolicyError(''); setSaving(true);
    try {
      await request(`/sync/policies/countries/${value.countryCode}`, { method: 'PUT', body: JSON.stringify({
        enabled, targetCount: Number(target),
        level1Limit: value.levelLimits[0], level2Limit: value.levelLimits[1],
        level3Limit: value.levelLimits[2], level4Limit: value.levelLimits[3],
        minPerNode: Number(minPerNode), coverageRatio: Number(coveragePercent) / 100,
        level1Min: Number(level1Min), level2Min: Number(level2Min)
      }) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setPolicyError(text.policyErrors[detail] || detail);
      setSaving(false);
      return;
    }
    setSaving(false);
    await mutate('/address-data', 'GET', undefined, text.saved);
  };
  return <form className="admin-form address-data-form" onSubmit={save}>
    <div className="policy-grid">
      <label><span>{text.target}</span><input name="targetCount" type="number" min="1" max="1000000000" required value={target} onChange={(event) => setTarget(event.target.value)} /></label>
      <label><span>{text.minPerNodeLabel}</span><input name="minPerNode" type="number" min="1" max="100" required value={minPerNode} onChange={(event) => setMinPerNode(event.target.value)} /></label>
      <label><span>{text.coverageGoal}</span><div className="percent-input"><input name="coveragePercent" type="number" min="0" max="100" step="1" required value={coveragePercent} onChange={(event) => setCoveragePercent(event.target.value)} /><b>%</b></div></label>
      <label><span>{text.level1MinLabel}</span><input name="level1Min" type="number" min="0" max="50000" required value={level1Min} onChange={(event) => setLevel1Min(event.target.value)} /></label>
      <label><span>{text.level2MinLabel}</span><input name="level2Min" type="number" min="0" max="50000" required value={level2Min} onChange={(event) => setLevel2Min(event.target.value)} /></label>
    </div>
    <label className="check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{text.enabled}</label>
    {policyError && <p className="field-error" role="alert">{policyError}</p>}
    <div className="dialog-actions"><button className="primary-action" disabled={busy || saving}>{text.save}</button></div>
  </form>;
}

export function AddressNodeTargets({ countryCode, locale, request }: { countryCode: string; locale: AdminLocale; request: RequestData }) {
  const text = addressDataText[locale];
  const t = adminText[locale];
  const [nodes, setNodes] = useState<AddressNodeTarget[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [panelError, setPanelError] = useState('');
  const [panelNotice, setPanelNotice] = useState('');
  const [levelTab, setLevelTab] = useState(0);
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(100);
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [rowBusy, setRowBusy] = useState('');
  const levelName = (level: number): string =>
    coverageLevels[locale][countryCode]?.[level] || coverageLevels[locale].default[level] || `L${level}`;
  const levels = useMemo(() => [...new Set((nodes || []).map((node) => node.level))].sort((left, right) => left - right), [nodes]);
  const query = search.trim().toLocaleLowerCase();
  const filtered = useMemo(() => (nodes || []).filter((node) => node.level === levelTab
    && (!query || node.regionName.toLocaleLowerCase().includes(query) || node.regionCode.toLocaleLowerCase().includes(query))), [nodes, levelTab, query]);
  const visible = filtered.slice(0, visibleCount);
  const loadNodes = async () => {
    setLoading(true); setPanelError('');
    try {
      const result = await request<AddressNodeTarget[]>(`/sync/policies/countries/${countryCode}/nodes`);
      setNodes(result || []);
      const first = [...new Set((result || []).map((node) => node.level))].sort((left, right) => left - right)[0];
      setLevelTab(first ?? 0);
    } catch (error) { setPanelError(errorMessage(error, locale)); }
    finally { setLoading(false); }
  };
  const applyOverride = (key: string, minCount: number | null) => setNodes((current) => (current || []).map((node) => {
    if (node.key !== key) return node;
    const targetCount = minCount ?? node.defaultTarget;
    return { ...node, overrideTarget: minCount, targetCount,
      satisfied: targetCount <= 0 || node.currentCount >= targetCount,
      deficit: Math.max(0, targetCount - node.currentCount),
      excess: minCount === null ? 0 : Math.max(0, node.currentCount - minCount) };
  }));
  const saveOverride = async (node: AddressNodeTarget, rawValue: string) => {
    setRowBusy(node.key); setPanelError(''); setPanelNotice('');
    try {
      await request(`/sync/policies/countries/${countryCode}/nodes/${encodeURIComponent(node.key)}`, {
        method: 'PUT', body: JSON.stringify({ minCount: Number(rawValue) })
      });
      applyOverride(node.key, Number(rawValue));
      setEditing(null); setPanelNotice(text.nodeSaved);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setPanelError(text.policyErrors[detail] || detail);
    } finally { setRowBusy(''); }
  };
  const clearOverride = async (node: AddressNodeTarget) => {
    setRowBusy(node.key); setPanelError(''); setPanelNotice('');
    try {
      await request(`/sync/policies/countries/${countryCode}/nodes/${encodeURIComponent(node.key)}`, { method: 'DELETE' });
      applyOverride(node.key, null);
      setPanelNotice(text.nodeCleared);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setPanelError(text.policyErrors[detail] || detail);
    } finally { setRowBusy(''); }
  };
  if (nodes === null) return <section className="node-targets">
    <h3>{text.nodeTargets}</h3>
    <div><button type="button" className="secondary-action" disabled={loading} onClick={() => void loadNodes()}>{loading ? t.loading : text.loadNodeTargets}</button></div>
    {panelError && <p className="field-error" role="alert">{panelError}</p>}
  </section>;
  return <section className="node-targets">
    <h3>{text.nodeTargets}</h3>
    <div className="node-targets-toolbar">
      <div className="node-level-tabs">{levels.map((level) => <button type="button" key={level} className={level === levelTab ? 'active' : ''} onClick={() => { setLevelTab(level); setVisibleCount(100); setEditing(null); }}>{levelName(level)} · {(nodes || []).filter((node) => node.level === level).length.toLocaleString(locale)}</button>)}</div>
      <label className="node-search"><Search size={13} /><input value={search} onChange={(event) => { setSearch(event.target.value); setVisibleCount(100); }} placeholder={text.searchNode} /></label>
    </div>
    {panelError && <p className="field-error" role="alert">{panelError}</p>}
    {panelNotice && <p className="node-panel-notice" role="status">{panelNotice}</p>}
    <div className="table-scroll node-target-table"><table><thead><tr><th>{t.region}</th><th>{text.current}</th><th>{text.target}</th><th>{t.statusLabel}</th><th>{t.actions}</th></tr></thead><tbody>{visible.map((node) => {
      const isEditing = editing?.key === node.key;
      return <tr key={node.key}>
        <td>{node.regionName}</td>
        <td className="numeric-cell">{node.currentCount.toLocaleString(locale)}</td>
        <td>{isEditing ? <span className="node-inline-edit">
          <input type="number" min="0" max="50000" autoFocus value={editing?.value ?? ''}
            onChange={(event) => setEditing({ key: node.key, value: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveOverride(node, editing?.value ?? ''); } }} />
          <button type="button" className="compact-action" disabled={rowBusy === node.key} onClick={() => void saveOverride(node, editing?.value ?? '')}>{t.save}</button>
          <button type="button" className="compact-action" onClick={() => setEditing(null)}>{t.cancel}</button>
        </span> : <><strong>{node.targetCount.toLocaleString(locale)}</strong><span className={`target-source-tag ${node.overrideTarget === null ? 'default' : 'override'}`}>{node.overrideTarget === null ? text.defaultTag : text.overrideTag}</span></>}</td>
        <td>{node.deficit > 0 ? <span className="node-chip deficit">{interpolate(text.deficitChip, { count: node.deficit.toLocaleString(locale) })}</span>
          : node.excess > 0 ? <span className="node-chip excess">{interpolate(text.excessChip, { count: node.excess.toLocaleString(locale) })}</span>
            : <span className="node-chip met">{text.metChip}</span>}</td>
        <td className="row-actions">
          <button type="button" disabled={rowBusy === node.key || isEditing} onClick={() => setEditing({ key: node.key, value: String(node.targetCount) })}>{t.edit}</button>
          {node.overrideTarget !== null && <button type="button" disabled={rowBusy === node.key} onClick={() => void clearOverride(node)}>{text.clearOverride}</button>}
        </td>
      </tr>;
    })}</tbody></table>{!filtered.length && <p className="admin-empty">{text.noNodes}</p>}</div>
    {filtered.length > visibleCount && <button type="button" className="secondary-action node-load-more" onClick={() => setVisibleCount((count) => count + 100)}>{text.loadMore} ({visible.length.toLocaleString(locale)}/{filtered.length.toLocaleString(locale)})</button>}
  </section>;
}
