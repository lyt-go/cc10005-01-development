import { useEffect, useState } from 'react'

import { fetchJson } from '@/api/client'

type Overview = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
  admission?: AdmissionSummary
}

type AdmissionSummary = {
  total: number
  passed: number
  rejected: number
  invalid: number
  occupied_proxies: number
}

type AdmissionRow = {
  id: number
  准入编号: string
  连接器编号: string
  实例编号: string
  代理地址: string
  目标域: string
  接入准入结论: string
  不可分配原因: string
  采样时刻: string
  负载采样时刻: string
  负载率: string
}

const fallbackCards = [{"label": "业务模块", "value": 0}, {"label": "今日新增", "value": 0}]
const fallbackModules = [{"name": "连接器管理", "created": 0, "pending": 0, "abnormal": 0}, {"name": "代理池管理", "created": 0, "pending": 0, "abnormal": 0}, {"name": "深度爬取", "created": 0, "pending": 0, "abnormal": 0}, {"name": "JS渲染采集", "created": 0, "pending": 0, "abnormal": 0}, {"name": "字段解析器", "created": 0, "pending": 0, "abnormal": 0}, {"name": "数据去噪", "created": 0, "pending": 0, "abnormal": 0}, {"name": "格式转换", "created": 0, "pending": 0, "abnormal": 0}, {"name": "采集去重", "created": 0, "pending": 0, "abnormal": 0}, {"name": "动态限速", "created": 0, "pending": 0, "abnormal": 0}, {"name": "验证码处理", "created": 0, "pending": 0, "abnormal": 0}, {"name": "采集监控", "created": 0, "pending": 0, "abnormal": 0}, {"name": "数据分发", "created": 0, "pending": 0, "abnormal": 0}, {"name": "种子管理", "created": 0, "pending": 0, "abnormal": 0}, {"name": "站点地图", "created": 0, "pending": 0, "abnormal": 0}, {"name": "Cookie管理", "created": 0, "pending": 0, "abnormal": 0}, {"name": "采集器健康", "created": 0, "pending": 0, "abnormal": 0}, {"name": "采集快照", "created": 0, "pending": 0, "abnormal": 0}, {"name": "操作审计", "created": 0, "pending": 0, "abnormal": 0}]

const conclusionClass: Record<string, string> = {
  准入通过: 'badge pass',
  准入拒绝: 'badge reject',
  已失效: 'badge invalid',
}

export default function Overview() {
  const [cards, setCards] = useState<Overview['cards']>(fallbackCards)
  const [moduleRows, setModuleRows] = useState<Overview['modules']>(fallbackModules)
  const [admission, setAdmission] = useState<AdmissionSummary | null>(null)
  const [admissionRows, setAdmissionRows] = useState<AdmissionRow[]>([])

  useEffect(() => {
    fetchJson<Overview>('/api/overview')
      .then((payload) => {
        setCards(payload.cards)
        setModuleRows(payload.modules)
        if (payload.admission) setAdmission(payload.admission)
      })
      .catch(() => undefined)
    fetchJson<{ items: AdmissionRow[] }>('/api/admission?size=8')
      .then((payload) => setAdmissionRows(payload.items ?? []))
      .catch(() => undefined)
  }, [])

  const admissionCards = admission
    ? [
        { label: '预检记录总数', value: admission.total },
        { label: '准入通过', value: admission.passed },
        { label: '准入拒绝（待复核）', value: admission.rejected },
        { label: '已失效', value: admission.invalid },
        { label: '被占用代理', value: admission.occupied_proxies },
      ]
    : []

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>运营概览</h2>
          <p className="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
        </div>
      </header>
      <div className="stat-row">
        {cards.map((card) => (
          <article key={card.label} className="stat-card">
            <span className="stat-label">{card.label}</span>
            <strong className="stat-value">{card.value}</strong>
          </article>
        ))}
      </div>

      <header className="page-head">
        <div>
          <h3>代理准入看板</h3>
          <p className="page-desc">
            代理可用性预检的接入准入结论，按「准入拒绝 → 准入通过 → 已失效」排列；
            完整明细与预检入口见「代理准入预检」视图。
          </p>
        </div>
      </header>
      <div className="stat-row">
        {admissionCards.map((card) => (
          <article key={card.label} className="stat-card">
            <span className="stat-label">{card.label}</span>
            <strong className="stat-value">{card.value}</strong>
          </article>
        ))}
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>数据连接器</th>
            <th>代理实例</th>
            <th>代理地址</th>
            <th>目标域</th>
            <th>接入准入结论</th>
            <th>不可分配原因</th>
            <th>采样时刻</th>
            <th>负载采样时刻</th>
            <th>负载率</th>
          </tr>
        </thead>
        <tbody>
          {admissionRows.map((row) => (
            <tr key={row.id}>
              <td>{row.连接器编号}</td>
              <td>{row.实例编号}</td>
              <td>{row.代理地址}</td>
              <td>{row.目标域}</td>
              <td>
                <span className={conclusionClass[row.接入准入结论] ?? 'badge'}>{row.接入准入结论}</span>
              </td>
              <td className={row.不可分配原因 ? 'reason-cell' : 'muted-cell'}>{row.不可分配原因 || '—'}</td>
              <td>{row.采样时刻}</td>
              <td>{row.负载采样时刻}</td>
              <td>{row.负载率}</td>
            </tr>
          ))}
          {admissionRows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={9}>暂无代理准入记录</td>
            </tr>
          )}
        </tbody>
      </table>

      <table className="data-table" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
        </thead>
        <tbody>
          {moduleRows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td>{row.created}</td>
              <td>{row.pending}</td>
              <td>{row.abnormal}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
