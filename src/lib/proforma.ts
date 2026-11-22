export type ExitKey = 'asIs' | 'paperLots' | 'finishedPads' | 'buildHomes'
export type CaseKey = 'downside' | 'base' | 'upside'

export const EXITS: { key: ExitKey; label: string; note: string }[] = [
  { key: 'asIs', label: 'Sell as is', note: 'Buy, hold, resell the raw land.' },
  { key: 'paperLots', label: 'Paper lots', note: 'Get the plat approved, sell lots with no site work.' },
  { key: 'finishedPads', label: 'Finished pads', note: 'Plat, grade pads, bring the road and utilities, sell lots.' },
  { key: 'buildHomes', label: 'Build homes', note: 'Finish the pads and build a home on each lot.' },
]

export interface Assumptions {
  landPrice: number
  closingPct: number
  lots: number
  earthworkCY: number
  asIsSalePrice: number
  asIsMonths: number
  entitlementCost: number
  paperLotPrice: number
  paperMonths: number
  siteWorkPerLot: number
  earthworkPerCY: number
  padLotPrice: number
  padMonths: number
  homeSqft: number
  buildCostPerSqft: number
  homePrice: number
  homeMonths: number
  sellingPct: number
  loanToCost: number
  interestRate: number
}

export interface CaseAdj {
  price: number
  cost: number
  time: number
}

export const CASES: Record<CaseKey, CaseAdj> = {
  downside: { price: 0.85, cost: 1.15, time: 1.3 },
  base: { price: 1, cost: 1, time: 1 },
  upside: { price: 1.1, cost: 0.95, time: 0.85 },
}

export type UseKey = 'land' | 'closing' | 'entitlement' | 'siteWork' | 'earthwork' | 'construction'

interface Flow {
  use: UseKey | 'revenue'
  amount: number
  from: number
  to: number
}

export interface Result {
  exit: ExitKey
  months: number
  revenue: number
  sellingCosts: number
  costs: Record<UseKey, number>
  interest: number
  profit: number
  margin: number
  peakCash: number
  returnOnPeak: number
  equity: number
  loan: number
  /** Cumulative equity cash position at the end of each month, month 0 first. */
  cumulative: number[]
}

function flows(a: Assumptions, exit: ExitKey, adj: CaseAdj): { months: number; list: Flow[] } {
  const c = adj.cost
  const p = adj.price
  const land: Flow[] = [
    { use: 'land', amount: a.landPrice, from: 0, to: 0 },
    { use: 'closing', amount: a.landPrice * a.closingPct, from: 0, to: 0 },
  ]
  const m = (base: number) => Math.max(1, Math.round(base * adj.time))
  const at = (months: number, share: number) => Math.max(1, Math.round(months * share))
  if (exit === 'asIs') {
    const M = m(a.asIsMonths)
    return { months: M, list: [...land, { use: 'revenue', amount: a.asIsSalePrice * p, from: M, to: M }] }
  }
  if (exit === 'paperLots') {
    const M = m(a.paperMonths)
    return {
      months: M,
      list: [
        ...land,
        { use: 'entitlement', amount: a.entitlementCost * c, from: 1, to: at(M, 0.6) },
        { use: 'revenue', amount: a.lots * a.paperLotPrice * p, from: at(M, 0.75), to: M },
      ],
    }
  }
  const site: Flow[] = [
    { use: 'siteWork', amount: a.lots * a.siteWorkPerLot * c, from: 0, to: 0 },
    { use: 'earthwork', amount: a.earthworkCY * a.earthworkPerCY * c, from: 0, to: 0 },
  ]
  if (exit === 'finishedPads') {
    const M = m(a.padMonths)
    site.forEach((f) => ((f.from = at(M, 0.3)), (f.to = at(M, 0.65))))
    return {
      months: M,
      list: [
        ...land,
        { use: 'entitlement', amount: a.entitlementCost * c, from: 1, to: at(M, 0.3) },
        ...site,
        { use: 'revenue', amount: a.lots * a.padLotPrice * p, from: at(M, 0.7), to: M },
      ],
    }
  }
  const M = m(a.homeMonths)
  site.forEach((f) => ((f.from = at(M, 0.15)), (f.to = at(M, 0.35))))
  return {
    months: M,
    list: [
      ...land,
      { use: 'entitlement', amount: a.entitlementCost * c, from: 1, to: at(M, 0.15) },
      ...site,
      { use: 'construction', amount: a.lots * a.homeSqft * a.buildCostPerSqft * c, from: at(M, 0.35), to: at(M, 0.9) },
      { use: 'revenue', amount: a.lots * a.homePrice * p, from: at(M, 0.6), to: M },
    ],
  }
}

/**
 * Monthly model. Each cost is split by loan-to-cost between the loan and equity.
 * Interest accrues monthly on the loan and is added to it. Sale proceeds, after
 * selling costs, repay the loan first, then go to equity. Any loan left at the
 * end is paid by equity. So profit equals the sum of equity cash flows.
 */
export function runExit(a: Assumptions, exit: ExitKey, kase: CaseKey = 'base'): Result {
  const { months, list } = flows(a, exit, CASES[kase])
  const costs: Record<UseKey, number> = { land: 0, closing: 0, entitlement: 0, siteWork: 0, earthwork: 0, construction: 0 }
  let loanBal = 0, loanDraws = 0, equityIn = 0, interest = 0, revenue = 0, selling = 0, cum = 0, peak = 0
  const cumulative: number[] = []
  const rate = a.interestRate / 12
  for (let t = 0; t <= months; t++) {
    const accrued = loanBal * rate
    loanBal += accrued
    loanDraws += accrued
    interest += accrued
    let cashT = 0
    for (const f of list) {
      if (t < f.from || t > f.to) continue
      const amt = f.amount / (f.to - f.from + 1)
      if (f.use === 'revenue') {
        const sell = amt * a.sellingPct
        revenue += amt
        selling += sell
        const net = amt - sell
        const repay = Math.min(loanBal, net)
        loanBal -= repay
        cashT += net - repay
      } else {
        costs[f.use] += amt
        const fromLoan = amt * a.loanToCost
        loanBal += fromLoan
        loanDraws += fromLoan
        equityIn += amt - fromLoan
        cashT -= amt - fromLoan
      }
    }
    if (t === months && loanBal > 0) {
      cashT -= loanBal
      equityIn += loanBal
      loanBal = 0
    }
    cum += cashT
    peak = Math.max(peak, -cum)
    cumulative.push(cum)
  }
  const totalCost = Object.values(costs).reduce((x, y) => x + y, 0)
  const profit = revenue - selling - totalCost - interest
  return {
    exit,
    months,
    revenue,
    sellingCosts: selling,
    costs,
    interest,
    profit,
    margin: revenue ? profit / revenue : 0,
    peakCash: peak,
    returnOnPeak: peak ? profit / peak : 0,
    equity: equityIn,
    loan: loanDraws,
    cumulative,
  }
}

/** Starting values only. Every number here is an illustrative assumption to replace. */
export function defaultAssumptions(lots: number, earthworkCY: number, acres: number): Assumptions {
  return {
    landPrice: Math.round((acres * 6000) / 1000) * 1000,
    closingPct: 0.03,
    lots,
    earthworkCY: Math.round(earthworkCY),
    asIsSalePrice: Math.round((acres * 6600) / 1000) * 1000,
    asIsMonths: 12,
    entitlementCost: 25000,
    paperLotPrice: 18000,
    paperMonths: 12,
    siteWorkPerLot: 30000,
    earthworkPerCY: 6,
    padLotPrice: 55000,
    padMonths: 18,
    homeSqft: 1600,
    buildCostPerSqft: 165,
    homePrice: 340000,
    homeMonths: 30,
    sellingPct: 0.06,
    loanToCost: 0.65,
    interestRate: 0.09,
  }
}
