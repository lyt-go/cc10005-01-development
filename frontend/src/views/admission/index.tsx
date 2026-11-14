import { useCallback, useEffect, useMemo, useState } from 'react'

import { request } from '@/api/client'

const ENDPOINT = '/api/admission'

type Row = Record<string, string | number | null>
type ProxyRow = Record<string, string | number | null>
type Summary = { total: number; passed: number; rejected: number; invalid: number; occupied_proxies: number }

const conclusionClass: Record<string, string> = {
  准入通过: 'badge pass',
  准入拒绝: 'badge reject',
  已失效: 'badge invalid',
}

const columns = [
  '准入编号',
  '连接器编号',
  '实例编号',
  '代理地址',
  '代理端口',
  '目标域',
  '接入准入结论',
  '不可分配原因',
  '采样时刻',
  '最近存活时间',
  '负载率',
  '负载采样时刻',
  '分配权重',
  '权重来源',
  '准入时刻',
  '失效时刻',
  '失效原因',
]

const fallbackSummary: Summary = { total: 0, passed: 0, rejected: 0, invalid: 0, occupied_proxies: 0 }

export default function AdmissionView() {
  const [rows, setRows] = useState<Row[]>([])
  const [connectors, setConnectors] = useState<Row[]>([])
  const [proxies, setProxies] = useState<ProxyRow[]>([])
  const [summary, setSummary] = useState<Summary>(fallbackSummary)
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [connectorId, setConnectorId] = useState('')
  const [proxyId, setProxyId] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const reload = useCallback(async () => {
    setErrorMessage('')
    const query = new URLSearchParams(filters).toString()
    try {
      const [listResp, summaryResp, connResp, proxyResp] = await Promise.all([
        request(`${ENDPOINT}?${query}&size=200`),
        request(`${ENDPOINT}/summary`),
        request('/api/connector?size=200'),
        request('/api/proxypool?size=200'),
      ])
      if (!listResp.ok || !summaryResp.ok || !connResp.ok || !proxyResp.ok) {
        throw new Error('代理准入数据读取失败')
      }
      const list = await listResp.json()
      setRows(list.items ?? [])
      setTotal(list.total ?? 0)
      setSummary(await summaryResp.json())
      setConnectors((await connResp.json()).items ?? [])
      setProxies((await proxyResp.json()).items ?? [])
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '代理准入列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    void reload()
  }, [reload])

  const stats = useMemo(
    () => [
      { label: '预检记录总数', value: summary.total },
      { label: '准入通过', value: summary.passed },
      { label: '准入拒绝（待复核）', value: summary.rejected },
      { label: '已失效', value: summary.invalid },
      { label: '当前被占用代理', value: summary.occupied_proxies },
    ],
    [summary],
  )

  async function runPrecheck() {
    setErrorMessage('')
    setNotice('')
    if (!connectorId) {
      setErrorMessage('请先选择数据连接器再发起预检')
      return
    }
    setSubmitting(true)
    try {
      const payload: Record<string, unknown> = { connector_id: Number(connectorId) }
      if (proxyId) payload.proxy_id = Number(proxyId)
      const response = await request(`${ENDPOINT}/precheck`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result?.detail ?? '预检请求未生效')
      }
      setNotice(result.message ?? '预检已完成')
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '代理可用性预检失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="page" data-module="admission">
      <header className="page-head">
        <div>
          <h2>代理准入预检</h2>
          <p className="page-desc">
            选择数据连接器后，按采样时刻同时评估目标域允许的代理地址、最近存活时间与当前负载，
            给出接入准入结论并回写连接器详情；列表按结论排列，拒绝记录优先供排班复核。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出准入清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
          void runPrecheck()
        }}
      >
        <label className="filter-item">
          <span>数据连接器（必选）</span>
          <select value={connectorId} onChange={(event) => setConnectorId(event.target.value)}>
            <option value="">请选择连接器</option>
            {connectors.map((row) => (
              <option key={String(row.id)} value={String(row.id)}>
                {String(row['连接器编号'])}（{String(row['目标域'] ?? '未登记目标域')} / {String(row.status)}）
              </option>
            ))}
          </select>
        </label>
        <label className="filter-item">
          <span>代理实例（留空则按权重/负载自动选优）</span>
          <select value={proxyId} onChange={(event) => setProxyId(event.target.value)}>
            <option value="">自动选优</option>
            {proxies.map((row) => (
              <option key={String(row.id)} value={String(row.id)}>
                {String(row['实例编号'])}（{String(row['代理地址'])} / {String(row.status)}）
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" type="submit" disabled={submitting}>
          {submitting ? '预检中…' : '发起代理可用性预检'}
        </button>
      </form>
      <p className="board-note">
        有效性边界：以本次预检的采样时刻为准，负载估算与分配权重均取该时刻快照；
        代理回收或连接器离线后历史结论置「已失效」留痕，不会覆盖历史接入结果。
      </p>

      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
          void reload()
        }}
      >
        <label className="filter-item">
          <span>连接器/实例编号</span>
          <input
            value={filters.keyword ?? ''}
            placeholder="按连接器或实例编号检索"
            onChange={(event) => setFilters((prev) => ({ ...prev, keyword: event.target.value }))}
          />
        </label>
        <label className="filter-item">
          <span>接入准入结论</span>
          <select
            value={filters.conclusion ?? ''}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, conclusion: event.target.value }))
            }
          >
            <option value="">全部结论</option>
            <option value="准入通过">准入通过</option>
            <option value="准入拒绝">准入拒绝</option>
            <option value="已失效">已失效</option>
          </select>
        </label>
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>
          重置条件
        </button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => {
                const value = row[column]
                if (column === '接入准入结论') {
                  return (
                    <td key={column}>
                      <span className={conclusionClass[String(value)] ?? 'badge'}>{String(value ?? '—')}</span>
                    </td>
                  )
                }
                if (column === '不可分配原因' || column === '失效原因') {
                  return (
                    <td key={column} className={value ? 'reason-cell' : 'muted-cell'}>
                      {value ?? '—'}
                    </td>
                  )
                }
                return (
                  <td key={column} className={value === null || value === '' ? 'muted-cell' : ''}>
                    {value ?? '—'}
                  </td>
                )
              })}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length}>
                暂无准入记录，请选择数据连接器发起一次代理可用性预检
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条准入记录（默认按接入准入结论排列：拒绝 → 通过 → 已失效）</span>
        {notice && <span style={{ color: '#067647' }}>{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
