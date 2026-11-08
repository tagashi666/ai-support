import type { Store } from '../store.js';

/** Статистика панели и статистические периоды. */
export class StatsRepo {
  statsResetAt(this: Store): number | null {
    const value = Number(this.getState('stats:reset_at'));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Начинает новый статистический период, не удаляя переписку и тикеты.
   * Это безопаснее физического обнуления: аудит и история сохраняются.
   */
  resetStats(this: Store, at = Date.now()): number {
    this.setState('stats:reset_at', String(at));
    this.logEvent('stats_reset', null, { at });
    return at;
  }

  /**
   * Сводка за период. Считаем в одном месте, потому что половина метрик
   * связана: доля автоответов бессмысленна без объёма, а среднее время
   * первого ответа врёт без медианы — один забытый на ночь диалог утягивает
   * среднее так, что цифра перестаёт что-либо значить.
   */
  stats(this: Store, days = 14) {
    const resetAt = this.statsResetAt();
    const since = Math.max(Date.now() - days * 86_400_000, resetAt ?? 0);
    const one = <T>(sql: string, ...params: unknown[]): T => this.db.prepare(sql).get(...(params as [])) as T;
    const all = <T>(sql: string, ...params: unknown[]): T[] => this.db.prepare(sql).all(...(params as [])) as T[];

    const totals = one<{ total: number; open: number; escalated: number; suspicious: number; waiting: number; handoff: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status NOT IN ('closed','resolved') THEN 1 ELSE 0 END), 0) AS open,
              COALESCE(SUM(escalated), 0) AS escalated,
              COALESCE(SUM(suspicious), 0) AS suspicious,
              COALESCE(SUM(CASE WHEN status NOT IN ('closed','resolved') AND last_inbound_at IS NOT NULL AND (
                NOT EXISTS (
                  SELECT 1 FROM message m
                   WHERE m.conversation_id = conversation.id AND m.direction = 'out'
                     AND m.created_at >= conversation.last_inbound_at
                )
                OR (handoff_at IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM message human
                   WHERE human.conversation_id = conversation.id AND human.direction = 'out'
                     AND human.author = 'agent' AND human.created_at > conversation.handoff_at
                ))
              ) THEN 1 ELSE 0 END), 0) AS waiting,
              COALESCE(SUM(CASE WHEN handoff_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS handoff
         FROM conversation`,
    );

    const liveCte = `WITH live AS (
      SELECT conversation_id, MIN(created_at) AS started_at
        FROM message
       WHERE direction = 'in' AND is_backfill = 0 AND created_at >= ?
       GROUP BY conversation_id
    )`;

    const period = one<{ conversations: number; resolved: number }>(
      `${liveCte}
       SELECT COUNT(*) AS conversations,
              COALESCE(SUM(CASE WHEN c.resolved_at IS NOT NULL
                                  AND c.resolved_at >= live.started_at THEN 1 ELSE 0 END), 0) AS resolved
         FROM live JOIN conversation c ON c.id = live.conversation_id`,
      since,
    );

    // Время первого ответа считаем по первой реальной реплике оператора.
    // first_response_at включает AI и поэтому раньше делал SLA красивее,
    // чем он был на самом деле.
    const responseTimes = all<{ ms: number }>(
      `${liveCte}
       SELECT MIN(m.created_at) - live.started_at AS ms
         FROM live
         JOIN message m ON m.conversation_id = live.conversation_id
        WHERE m.direction = 'out' AND m.author = 'agent'
          AND m.created_at >= live.started_at
        GROUP BY live.conversation_id ORDER BY ms`,
      since,
    ).map((row) => row.ms);
    const median = responseTimes.length
      ? responseTimes[Math.floor(responseTimes.length / 2)]!
      : null;
    const average = responseTimes.length
      ? Math.round(responseTimes.reduce((sum, ms) => sum + ms, 0) / responseTimes.length)
      : null;
    const p90 = responseTimes.length
      ? responseTimes[Math.min(responseTimes.length - 1, Math.ceil(responseTimes.length * 0.9) - 1)]!
      : null;

    const resolutionTimes = all<{ ms: number }>(
      `${liveCte}
       SELECT c.resolved_at - live.started_at AS ms
         FROM live JOIN conversation c ON c.id = live.conversation_id
        WHERE c.resolved_at IS NOT NULL AND c.resolved_at >= live.started_at
        ORDER BY ms`,
      since,
    ).map((row) => row.ms);
    const medianResolution = resolutionTimes.length
      ? resolutionTimes[Math.floor(resolutionTimes.length / 2)]!
      : null;
    const averageResolution = resolutionTimes.length
      ? Math.round(resolutionTimes.reduce((sum, ms) => sum + ms, 0) / resolutionTimes.length)
      : null;

    const byChannel = all<{ channel: string; n: number }>(
      `${liveCte}
       SELECT c.channel, COUNT(*) AS n
         FROM live JOIN conversation c ON c.id = live.conversation_id
        GROUP BY c.channel ORDER BY n DESC`,
      since,
    );

    const suggestions = all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM ai_suggestion WHERE created_at > ? GROUP BY status`,
      since,
    );

    const volume = all<{ day: string; incoming: number; outgoing: number; byAi: number; byHuman: number }>(
      `SELECT DATE(created_at / 1000, 'unixepoch') AS day,
              SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS incoming,
              SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS outgoing,
              SUM(CASE WHEN direction = 'out' AND author = 'ai' THEN 1 ELSE 0 END) AS byAi,
              SUM(CASE WHEN direction = 'out' AND author = 'agent' THEN 1 ELSE 0 END) AS byHuman
         FROM message WHERE created_at > ? AND is_backfill = 0 GROUP BY day ORDER BY day`,
      since,
    );

    // Часы суток: показывает, когда обращения приходят, а когда можно спать.
    const hours = all<{ hour: string; n: number }>(
      `SELECT STRFTIME('%H', created_at / 1000, 'unixepoch') AS hour, COUNT(*) AS n
         FROM message WHERE direction = 'in' AND is_backfill = 0 AND created_at > ? GROUP BY hour ORDER BY hour`,
      since,
    );

    const events = all<{ kind: string; n: number }>(
      `SELECT kind, COUNT(*) AS n FROM event WHERE created_at > ? AND kind != 'ai_usage' GROUP BY kind ORDER BY n DESC LIMIT 8`,
      since,
    );

    // Какие статьи базы знаний реально работают: по ним видно, что дописать.
    const sourceCount = new Map<string, number>();
    for (const row of all<{ sources: string | null }>(
      `SELECT sources FROM ai_suggestion WHERE sources IS NOT NULL AND created_at > ?`, since,
    )) {
      try {
        for (const title of JSON.parse(row.sources ?? '[]') as string[]) {
          sourceCount.set(title, (sourceCount.get(title) ?? 0) + 1);
        }
      } catch { /* повреждённую запись пропускаем */ }
    }
    const topSources = [...sourceCount.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([title, n]) => ({ title, n }));

    const accepted = suggestions.filter((r) => r.status === 'sent' || r.status === 'edited').reduce((s2, r) => s2 + r.n, 0);
    const decided = suggestions.filter((r) => r.status !== 'pending').reduce((s2, r) => s2 + r.n, 0);
    const outgoing = volume.reduce((s2, v) => s2 + v.outgoing, 0);
    const byAi = volume.reduce((s2, v) => s2 + v.byAi, 0);
    const byHuman = volume.reduce((s2, v) => s2 + v.byHuman, 0);

    return {
      days,
      since,
      resetAt,
      totals,
      period,
      avgFirstResponseMs: average,
      medianFirstResponseMs: median,
      p90FirstResponseMs: p90,
      answered: responseTimes.length,
      avgResolutionMs: averageResolution,
      medianResolutionMs: medianResolution,
      resolved: resolutionTimes.length,
      byChannel,
      suggestions,
      acceptanceRate: decided ? accepted / decided : null,
      aiShare: outgoing ? byAi / outgoing : null,
      automationRate: byAi + byHuman ? byAi / (byAi + byHuman) : null,
      aiReplies: byAi,
      humanReplies: byHuman,
      volume,
      hours,
      events,
      topSources,
      aiUsage: this.aiUsage(),
      kb: this.kbCount(),
    };
  }

  /**
   * Расход токенов AI из журнала событий ai_usage: сегодня и за 7 дней по
   * назначению, плюс средний вход на один ответ клиенту. Окна фиксированные,
   * от периода статистики не зависят: лимиты провайдера считаются по суткам.
   */
  aiUsage(this: Store, now = Date.now()) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const rows = (since: number) => this.db.prepare(
      `SELECT COALESCE(json_extract(payload, '$.purpose'), 'other') AS purpose,
              COUNT(*) AS requests,
              COALESCE(SUM(json_extract(payload, '$.prompt')), 0) AS prompt,
              COALESCE(SUM(json_extract(payload, '$.completion')), 0) AS completion,
              COALESCE(SUM(json_extract(payload, '$.cached')), 0) AS cached
         FROM event WHERE kind = 'ai_usage' AND created_at > ?
        GROUP BY purpose ORDER BY prompt + completion DESC`,
    ).all(since) as { purpose: string; requests: number; prompt: number; completion: number; cached: number }[];
    const week = rows(now - 7 * 86_400_000);
    const reply = week.find((row) => row.purpose === 'reply');
    return {
      today: rows(today.getTime()),
      week,
      avgReplyPrompt: reply?.requests ? Math.round(reply.prompt / reply.requests) : null,
    };
  }
}
