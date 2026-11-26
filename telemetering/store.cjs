const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

// The latest reporting day determines the environment for the whole 30-day window.
// Preserve complete rows when an upgrade changes more than one dimension.
const distributionSql = `
  WITH latest_days AS (
    SELECT install_key, MAX(activity_date) AS activity_date
    FROM daily_activity
    WHERE activity_date BETWEEN date(:today, '-29 days') AND :today
    GROUP BY install_key
  ), latest AS (
    SELECT activity.*, activity_date = :today AS active_today
    FROM daily_activity AS activity JOIN latest_days USING (install_key, activity_date)
  ), buckets AS (
    SELECT 'versions' AS kind, json_object('app_version', app_version) AS labels, active_today FROM latest
    UNION ALL
    SELECT 'systems', json_object('os_family', os_family, 'os_version_group', os_version_group), active_today FROM latest
    UNION ALL
    SELECT 'architectures', json_object('os_family', os_family, 'os_arch', os_arch, 'app_arch', app_arch), active_today FROM latest
  )
  SELECT kind, labels, COUNT(*) AS period_count, SUM(active_today) AS today_count
  FROM buckets GROUP BY kind, labels ORDER BY kind, labels
`

const dailySeriesSql = `
  WITH RECURSIVE days(day) AS (
    SELECT date(:today, '-29 days')
    UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < :today
  )
  SELECT days.day AS activity_date, COUNT(activity.install_key) AS active_installs
  FROM days LEFT JOIN daily_activity AS activity ON activity.activity_date = days.day
  GROUP BY days.day ORDER BY days.day
`

function emptyPeriod() {
  return { active_installs: 0, versions: [], systems: [], architectures: [] }
}

/** Opens the dedicated activity database. Each update commits atomically, including across writers. */
function openStore(filename) {
  const db = new DatabaseSync(filename)
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS daily_activity (
        install_key BLOB NOT NULL,
        activity_date TEXT NOT NULL,
        revision INTEGER NOT NULL,
        app_version TEXT NOT NULL,
        os_family TEXT NOT NULL,
        os_version_group TEXT NOT NULL,
        os_arch TEXT NOT NULL,
        app_arch TEXT NOT NULL,
        PRIMARY KEY (install_key, activity_date)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS activity_by_date ON daily_activity(activity_date);
    `)
    const upsert = db.prepare(`
      INSERT INTO daily_activity (install_key, activity_date, revision, app_version, os_family, os_version_group, os_arch, app_arch)
      SELECT :install_key, :activity_date, :revision, :app_version, :os_family, :os_version_group, :os_arch, :app_arch
      WHERE :activity_date BETWEEN date(:today, '-29 days') AND :today
      ON CONFLICT (install_key, activity_date) DO UPDATE SET
        revision = excluded.revision, app_version = excluded.app_version, os_family = excluded.os_family,
        os_version_group = excluded.os_version_group, os_arch = excluded.os_arch, app_arch = excluded.app_arch
      WHERE excluded.revision > daily_activity.revision
    `)
    const distributions = db.prepare(distributionSql)
    const dailySeries = db.prepare(dailySeriesSql)
    const pruneExpired = db.prepare("DELETE FROM daily_activity WHERE activity_date < date(?, '-29 days')")

    function record(report, today) {
      const { install_id, activity_date, revision, app_version, os_family, os_version_group, os_arch, app_arch } = report
      // Only the digest of the random install UUID is needed for equality comparisons.
      const install_key = createHash('sha256').update(install_id).digest()
      return upsert.run({ install_key, activity_date, revision, app_version, os_family, os_version_group, os_arch, app_arch, today }).changes
    }

    /** Reads the trend and both distributions from the same SQLite snapshot. */
    function summary(today) {
      db.exec('BEGIN')
      let groups, daily_active
      try {
        groups = distributions.all({ today })
        daily_active = dailySeries.all({ today })
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      const result = { today: emptyPeriod(), last_30_days: emptyPeriod(), daily_active }
      for (const { kind, labels, period_count, today_count } of groups) {
        const fields = JSON.parse(labels)
        result.last_30_days[kind].push({ ...fields, count: period_count })
        if (today_count) result.today[kind].push({ ...fields, count: today_count })
      }
      for (const period of [result.today, result.last_30_days]) {
        period.active_installs = period.versions.reduce((total, bucket) => total + bucket.count, 0)
        // SQL already established a stable label order for equally sized buckets.
        for (const buckets of [period.versions, period.systems, period.architectures]) {
          buckets.sort((left, right) => right.count - left.count)
        }
      }
      return result
    }

    return { record, summary, prune: today => pruneExpired.run(today).changes, close: () => db.close() }
  } catch (error) {
    db.close()
    throw error
  }
}

module.exports = { openStore }
