export const GOAL_SPANS = Object.freeze([1, 3, 5, 10]);
export const goalSpan = goal => goal.span ?? 1;
export const spanLabel = span => span === 1 ? '年度' : span + ' 年';
export const rangeLabel = (year, span) => span === 1 ? String(year) : year + '–' + (year + span - 1);

export function validGoalPeriod(span, year) {
  return GOAL_SPANS.includes(span) && Number.isInteger(year) && year >= 1 && year <= 10000 - span;
}
export const lastGoalStart = (span, currentYear) => Math.min(10000 - span, currentYear + 1 + (span === 1 ? 0 : span));
export const defaultGoalStart = (span, currentYear) => Math.min(currentYear, 10000 - span);

export function shiftGoalPeriod(year, span, direction, currentYear) {
  const next = year + direction * span;
  return validGoalPeriod(span, next) && (direction < 0 || next <= lastGoalStart(span, currentYear)) ? next : null;
}

export const yearId = year => String(year).padStart(4, '0');
export const planId = (span, year) => span + ':' + yearId(year);

export function readPlanId(id) {
  if (!/^(3|5|10):\d{4}$/.test(id)) return;
  const [span, year] = id.split(':').map(Number);
  if (validGoalPeriod(span, year)) return { span, year };
}

export const samePeriod = (row, span, year) => goalSpan(row) === span && row.year === year;
