import { useCallback, useEffect, useMemo, useState } from 'react'

import { request } from '@/api/client'

const ENDPOINT = '/api/connector'
const columns = [
  "连接器编号",
  "协议类型",
  "目标端点",
  "目标域",
  "认证参数",
  "重连次数",
  "心跳间隔",
  "数据编码",
  "超时阈值"
]
const admissionColumns = [
  "准入结论",
  "准入状态",
  "分配代理实例",
  "分配代理地址",
  "准入编号",
  "准入时刻",
  "负载采样时刻",
  "负载率",
  "最近预检结论",
  "最近不可分配原因"
]
const actions = [
  "发起连通测试",
  "标记就绪",
  "标记离线"
]
const statuses = [
  "草稿",
  "连通测试中",
  "已就绪",
  "已离线"
]
const stats = [
  {
    "label": "连接器总数",
    "value": 0
  },
  {
    "label": "已就绪连接器",
    "value": 0
  },
  {
    "label": "测试中连接器",
    "value": 0
  }
]

type Row = Record<string, string | number | null>
type ProxyRow = Record<string, string | number | null>

export default function ConnectorView() {
  const [rows, setRows] = useState<Row[]>([])
  const [proxies, setProxies] = useState<ProxyRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [precheckProxy, setPrecheckProxy] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(async () => {
    setErrorMessage('')
    const query = new URLSearchParams(filters).toString()
    try {
      const [response, proxyResponse] = await Promise.all([
        request(`${ENDPOINT}?${query}&size=200`),
        request('/api/proxypool?size=200'),
      ])
      if (!response.ok || !proxyResponse.ok) {
        throw new Error('数据连接器列表读取失败')
      }
      const payload = await response.json()
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
      setProxies((await proxyResponse.json()).items ?? [])
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '连接器管理列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    void reload()
  }, [reload])

  async function runAction(action: string, row: Row) {
    setErrorMessage('')
    setNotice('')
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ values: { action } }),
      })
      if (!response.ok) {
        throw new Error('连接器管理动作未生效，请稍后重试')
      }
      const result = await response.json()
      setNotice(result.message ?? '动作已生效')
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '连接器管理操作失败')
    }
  }

  async function runPrecheck(row: Row) {
    setErrorMessage('')
    setNotice('')
    const payload: Record<string, unknown> = { connector_id: Number(row.id) }
    const proxyId = precheckProxy[String(row.id)]
    if (proxyId) payload.proxy_id = Number(proxyId)
    try {
      const response = await request('/api/admission/precheck', {
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
    }
  }

  return (
    <section className="page" data-module="connector">
      <header className="page-head">
        <div>
          <h2>连接器管理管理</h2>
          <p className="page-desc">管理各类数据源的连接器配置，支持HTTP、数据库、消息队列等多种协议的统一接入；发起连通测试前可先做代理可用性预检。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('数据连接器登记入口尚未接入审批流')}>
            登记数据连接器
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出连接器管理清单
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

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); void reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            {admissionColumns.map((column) => <th key={column}>{column}</th>)}
            <th>代理可用性预检</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              {admissionColumns.map((column) => {
                const value = row[column]
                const isReason = column === '最近不可分配原因'
                return (
                  <td key={column} className={isReason && value ? 'reason-cell' : value === null || value === '' ? 'muted-cell' : ''}>
                    {value ?? '—'}
                  </td>
                )
              })}
              <td>
                <div className="row-actions">
                  <select
                    value={precheckProxy[String(row.id)] ?? ''}
                    onChange={(event) =>
                      setPrecheckProxy((prev) => ({ ...prev, [String(row.id)]: event.target.value }))
                    }
                  >
                    <option value="">自动选优</option>
                    {proxies.map((proxy) => (
                      <option key={String(proxy.id)} value={String(proxy.id)}>
                        {String(proxy['实例编号'])}（{String(proxy['代理地址'])}）
                      </option>
                    ))}
                  </select>
                  <button className="link" type="button" onClick={() => void runPrecheck(row)}>
                    发起预检
                  </button>
                </div>
              </td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => void runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + admissionColumns.length + 2}>暂无连接器管理数据，可先登记数据连接器</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条连接器管理记录；准入字段为预检通过后的回写快照，历史结论以「代理准入预检」视图为准</span>
        {notice && <span style={{ color: '#067647' }}>{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
