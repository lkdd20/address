import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, CalendarDays, Database, Globe2, House, Maximize2, RefreshCw, Search, Target, X } from 'lucide-react';
import { countryByCode, isCountryCode } from '../../domain/countries';
import { useMapDialogFocus, WorldCoverageMap } from '../WorldCoverageMap';
import { localeText } from './locale-text';
import { adminText, continentLabel, coverageLevelName, coverageRegionName, dateTime, flagSrc, formatBytes, interpolate, usesChineseSource } from './text';
import type { AdminLocale, CoverageNode, DashboardData, SystemStatus } from './types';

export function DashboardLoading({ label }: { label: string }) {
  return <div className="dashboard-loading" role="status" aria-label={label}>
    <div className="dashboard-loading-metrics">{[0, 1, 2, 3].map((value) => <span key={value} />)}</div>
    <div className="dashboard-loading-panel"><i /><i /><i /><i /><i /></div>
  </div>;
}
export function SidebarStatus({ metrics, locale }: { metrics?: SystemStatus; locale: AdminLocale }) {
  const t = adminText[locale];
  const ui = localeText[locale].ui;
  const health = !metrics ? '' : metrics.serviceHealthy ? 'healthy' : metrics.databaseHealthy ? 'warning' : 'down';
  const label = !metrics ? '-' : metrics.serviceHealthy ? t.runningNormally : metrics.databaseHealthy ? ui.schedulerStale : ui.databaseDown;
  return <section className="admin-sidebar-status">
    <div><span className={`status-indicator ${health}`} /><span>{t.systemStatus}</span><strong title={metrics?.schedulerHeartbeatAt ? dateTime(metrics.schedulerHeartbeatAt, locale) : undefined}>{label}</strong></div>
    <div><Activity size={14} /><span>{t.apiRequestsToday}</span><strong>{metrics?.apiRequestsToday?.toLocaleString(locale) ?? '-'}</strong></div>
    <div><Database size={14} /><span>{t.databaseSize}</span><strong>{metrics?.databaseBytes === undefined ? '-' : formatBytes(metrics.databaseBytes)}</strong></div>
    <div><CalendarDays size={14} /><span>{t.lastDataUpdate}</span><strong>{metrics?.lastUpdatedAt ? dateTime(metrics.lastUpdatedAt, locale) : '-'}</strong></div>
  </section>;
}
export function WorldDistributionMap({ countries, selected, locale, open, expanded = false }: {
  countries: CoverageNode[]; selected?: CoverageNode; locale: AdminLocale; open: (node: CoverageNode) => void; expanded?: boolean;
}) {
  return <WorldCoverageMap
    countries={countries}
    selected={selected}
    label={(country) => coverageRegionName(country, locale)}
    ariaLabel={selected ? coverageRegionName(selected, locale) : adminText[locale].globalDistribution}
    onSelect={open}
    expanded={expanded}
    mapText={{ loading: adminText[locale].loading, retry: adminText[locale].retry,
      error: localeText[locale].ui.mapError }}
  />;
}
export function ExpandedMapDialog({ countries, selected, locale, open, close }: {
  countries: CoverageNode[]; selected?: CoverageNode; locale: AdminLocale; open: (node: CoverageNode) => void; close: () => void;
}) {
  const root = useMapDialogFocus(true, close);
  const title = selected ? coverageRegionName(selected, locale) : adminText[locale].globalDistribution;
  return createPortal(<div className="map-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section ref={root} tabIndex={-1} className="map-dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button type="button" className="icon-button" title={adminText[locale].close} aria-label={adminText[locale].close} onClick={close}><X size={18} /></button></header><WorldDistributionMap countries={countries} selected={selected} locale={locale} open={open} expanded /></section></div>, document.body);
}
export function DashboardMetric({ label, value, icon: Icon, tone, detail }: { label: string; value: string; icon: typeof Globe2; tone: string; detail?: string }) {
  return <article className="dashboard-kpi"><span className={`dashboard-kpi-icon ${tone}`}><Icon size={20} /></span><div><small>{label}</small><strong>{value}</strong>{detail && <em>{detail}</em>}</div></article>;
}
export type MajorContinent = 'all' | 'asia' | 'europe' | 'north-america' | 'south-america' | 'africa' | 'oceania';
export type CountrySortMode = 'residential-desc' | 'residential-asc' | 'country-name' | 'coverage-desc';
export const majorContinentByGroup: Record<string, Exclude<MajorContinent, 'all'>> = {
  'east-asia': 'asia', 'southeast-asia': 'asia', 'south-asia': 'asia', 'middle-east': 'asia',
  europe: 'europe', 'north-america': 'north-america', 'south-america': 'south-america', africa: 'africa', oceania: 'oceania'
};
export const countryCoverageRatio = (node: CoverageNode): number => {
  const levels = node.coverageLevels || [];
  const total = levels.reduce((sum, level) => sum + level.total, 0);
  return total ? levels.reduce((sum, level) => sum + level.covered, 0) / total : 0;
};
export function Dashboard({ value, locale, coverageTrail, openCoverage, returnCoverage }: {
  value: DashboardData; locale: AdminLocale; coverageTrail: CoverageNode[];
  openCoverage: (node: CoverageNode) => void; returnCoverage: (index: number) => void;
}) {
  const t = adminText[locale];
  const ui = localeText[locale].ui;
  const [page, setPage] = useState(1);
  const [localSearch, setLocalSearch] = useState('');
  const [continent, setContinent] = useState<MajorContinent>('all');
  const [sortMode, setSortMode] = useState<CountrySortMode>('residential-desc');
  const [mapExpanded, setMapExpanded] = useState(false);
  const selectedCountry = coverageTrail[0];
  const root = !coverageTrail.length;
  const query = root ? localSearch.trim().toLocaleLowerCase() : '';
  const filtered = useMemo(() => value.nodes.filter((node) => {
    const meta = isCountryCode(node.countryCode) ? countryByCode.get(node.countryCode) : undefined;
    if (continent !== 'all' && (!meta || majorContinentByGroup[meta.group] !== continent)) return false;
    if (!query) return true;
    return [node.countryCode, node.regionName, node.regionNameEn, node.regionNameZh].filter(Boolean)
      .some((item) => String(item).toLocaleLowerCase().includes(query));
  }).sort((left, right) => {
    if (sortMode === 'residential-asc') return left.residentialCount - right.residentialCount || left.countryCode.localeCompare(right.countryCode);
    if (sortMode === 'country-name') return coverageRegionName(left, locale).localeCompare(coverageRegionName(right, locale), locale);
    if (sortMode === 'coverage-desc') return countryCoverageRatio(right) - countryCoverageRatio(left) || right.residentialCount - left.residentialCount;
    return right.residentialCount - left.residentialCount || left.countryCode.localeCompare(right.countryCode);
  }), [continent, locale, query, sortMode, value.nodes]);
  useEffect(() => setPage(1), [continent, query, sortMode, value.nodes]);
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = root ? filtered : filtered.slice((page - 1) * pageSize, page * pageSize);
  return <div className="dashboard-page">
    {root && <section className="dashboard-kpis">
      <DashboardMetric label={t.countriesCovered} value={value.metrics.countryCount.toLocaleString()} icon={Globe2} tone="blue" />
      <DashboardMetric label={ui.addressTotal} value={value.metrics.addressTotal.toLocaleString(locale)} detail={interpolate(ui.residentialShare, { count: value.metrics.residentialTotal.toLocaleString(locale) })} icon={House} tone="green" />
      <DashboardMetric label={t.regionsCovered} value={`${(value.metrics.coverageRate * 100).toFixed(1)}%`} detail={`${value.metrics.coveredLowest.toLocaleString(locale)} / ${value.metrics.totalLowest.toLocaleString(locale)}`} icon={Target} tone="amber" />
      <DashboardMetric label={ui.todayGrowth} value={`${value.metrics.todayGrowth > 0 ? '+' : ''}${value.metrics.todayGrowth.toLocaleString(locale)}`} icon={RefreshCw} tone="violet" />
    </section>}
    <div className="coverage-breadcrumb dashboard-breadcrumb"><button onClick={() => returnCoverage(-1)}>{t.allCountries}</button>{coverageTrail.map((node, index) => <span key={node.key}>/<button onClick={() => returnCoverage(index)}>{coverageRegionName(node, locale)}</button></span>)}</div>
    <section className="dashboard-map-row">
      <article className="dashboard-card map-card"><header><div><h2>{selectedCountry ? coverageRegionName(selectedCountry, locale) : t.globalDistribution}</h2></div><button type="button" className="map-expand-button" title={localeText[locale].ui.expandMap} aria-label={localeText[locale].ui.expandMap} onClick={() => setMapExpanded(true)}><Maximize2 size={17} /></button></header><WorldDistributionMap countries={value.countries} selected={selectedCountry} locale={locale} open={openCoverage} /></article>
    </section>
    <section className="dashboard-card country-data-table"><header><div><h2>{root ? t.countryDataList : coverageRegionName(coverageTrail.at(-1)!, locale)}</h2></div>{root && <div className="country-table-tools"><label className="country-search"><Search size={14} /><input value={localSearch} onChange={(event) => setLocalSearch(event.target.value)} placeholder={t.searchCountry} /></label><select aria-label={t.sortBy} value={sortMode} onChange={(event) => setSortMode(event.target.value as CountrySortMode)}><option value="residential-desc">{t.sortResidentialDesc}</option><option value="residential-asc">{t.sortResidentialAsc}</option><option value="country-name">{t.sortCountryName}</option><option value="coverage-desc">{t.sortCoverageDesc}</option></select><select aria-label={t.continentFilter} value={continent} onChange={(event) => setContinent(event.target.value as MajorContinent)}><option value="all">{t.allContinents}</option><option value="asia">{t.asia}</option><option value="europe">{t.europe}</option><option value="north-america">{t.northAmerica}</option><option value="south-america">{t.southAmerica}</option><option value="africa">{t.africa}</option><option value="oceania">{t.oceania}</option></select></div>}</header>
      {root ? <CountryCoverageTable values={visible} open={openCoverage} locale={locale} /> : <CoverageTable values={visible} open={openCoverage} locale={locale} />}
      {!root && <div className="table-pagination"><span>{page} / {pages}</span><div><button disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>{t.previous}</button><button disabled={page >= pages} onClick={() => setPage((current) => current + 1)}>{t.next}</button></div></div>}
    </section>{mapExpanded && <ExpandedMapDialog countries={value.countries} selected={selectedCountry} locale={locale} open={openCoverage} close={() => setMapExpanded(false)} />}
  </div>;
}
export const CountryCoverageTable = ({ values, open, locale }: { values: CoverageNode[]; open: (value: CoverageNode) => void; locale: AdminLocale }) => {
  const t = adminText[locale];
  const ui = localeText[locale].ui;
  const headings = { country: t.country, region: t.region, total: t.totalResidential, coverage: t.coverageColumns, first: ui.levelFirst, second: ui.levelSecond, third: ui.levelThird };
  return <div className="table-scroll"><table className="country-coverage-table"><thead><tr><th rowSpan={2}>{headings.country}</th><th rowSpan={2}>{headings.region}</th><th rowSpan={2}>{headings.total}</th><th colSpan={3}>{headings.coverage}</th></tr><tr><th>{headings.first}</th><th>{headings.second}</th><th>{headings.third}</th></tr></thead><tbody>{values.map((item) => {
    const countryCode = item.countryCode.toUpperCase();
    const meta = isCountryCode(countryCode) ? countryByCode.get(countryCode) : undefined;
    const levels = item.coverageLevels || [];
    return <tr key={item.key}><td><button className="country-name-button" disabled={!item.childCount} onClick={() => open(item)}><img className="country-flag" src={flagSrc(countryCode)} width="24" height="18" alt="" loading="lazy" /><strong>{coverageRegionName(item, locale)}</strong></button></td><td>{meta ? continentLabel(meta.group, locale) : '-'}</td><td className="numeric-cell">{item.residentialCount.toLocaleString()}</td>{[0, 1, 2].map((index) => {
      const level = levels[index];
      return <td key={index}>{level ? <span className="coverage-value"><small>{usesChineseSource(locale) ? level.labelZh : level.labelEn}</small><b>{level.covered.toLocaleString()} / {level.total.toLocaleString()}</b></span> : '-'}</td>;
    })}</tr>;
  })}</tbody></table>{!values.length && <p className="admin-empty">{adminText[locale].noSubregions}</p>}</div>;
};
export const CoverageTable = ({ values, open, locale }: { values: CoverageNode[]; open: (value: CoverageNode) => void; locale: AdminLocale }) => {
  const t = adminText[locale];
  return <div className="table-scroll"><table><thead><tr><th>{t.region}</th><th>{t.level}</th><th>{t.residential}</th><th>{t.administrativeCoverage}</th></tr></thead><tbody>{values.map((item) => <tr key={item.key}>
    <td><button className="drill-button" disabled={!item.childCount} title={!item.childCount ? t.noSubregions : undefined} onClick={() => open(item)}>{coverageRegionName(item, locale)}</button>{!item.totalCount && <span className="coverage-empty-tag">{t.noAddressData}</span>}</td>
    <td>{coverageLevelName(item, locale)}</td><td>{item.residentialCount.toLocaleString()}</td>
    <td>{item.coverageLevels?.length ? <div className="coverage-ratios">{item.coverageLevels.map((level) => <span key={level.key} title={`${t.qualifiedCoverage}: ${level.qualified.toLocaleString()} / ${level.total.toLocaleString()}`}><b>{usesChineseSource(locale) ? level.labelZh : level.labelEn}</b>{level.covered.toLocaleString()} / {level.total.toLocaleString()}</span>)}</div> : item.childCount.toLocaleString()}</td>
  </tr>)}</tbody></table>{!values.length && <p className="admin-empty">{t.noSubregions}</p>}</div>;
};
