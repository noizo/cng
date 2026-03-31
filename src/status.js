export async function fetchStatusData(env) {
  try {
    const accountId = (env.CF_ACCOUNT_ID || "").replace(/[^a-f0-9]/gi, "");
    if (!accountId) throw new Error("Missing CF_ACCOUNT_ID");

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const dayOfMonth = now.getUTCDate();
    const workerName = (env.WORKER_NAME || "cng").replace(/[^a-zA-Z0-9_-]/g, "");

    const gql = `{
    viewer {
        accounts(filter:{accountTag:"${accountId}"}) {
        neurons: aiInferenceAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${todayStart.toISOString()}", datetime_leq: "${now.toISOString()}" }
          orderBy: [sum_totalNeurons_DESC]
        ) {
          count
          sum { totalNeurons totalInputTokens totalOutputTokens totalInferenceTimeMs }
          dimensions { modelId }
        }
        monthly: aiInferenceAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${monthStart.toISOString()}", datetime_leq: "${now.toISOString()}" }
        ) {
          sum { totalNeurons }
          count
        }
        daily: aiInferenceAdaptiveGroups(
          limit: 31
          filter: { datetime_geq: "${monthStart.toISOString()}", datetime_leq: "${now.toISOString()}" }
        ) {
          sum { totalNeurons }
          dimensions { date }
        }
        invocations: workersInvocationsAdaptive(
          limit: 10
          filter: {
            datetime_geq: "${todayStart.toISOString()}"
            datetime_leq: "${now.toISOString()}"
            scriptName: "${workerName}"
          }
        ) {
          sum { requests errors subrequests }
          dimensions { status }
        }
      }
    }
  }`;

    const gqlResp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: gql }),
    });

    const gqlData = await gqlResp.json().catch(() => null);
    const acct = gqlData?.data?.viewer?.accounts?.[0] || {};

    const neuronRows = (acct.neurons || []).map((r) => ({
      model: r.dimensions?.modelId?.split("/").pop() || "unknown",
      model_full: r.dimensions?.modelId,
      requests: r.count,
      neurons: Math.round((r.sum?.totalNeurons ?? 0) * 100) / 100,
      input_tokens: r.sum?.totalInputTokens ?? 0,
      output_tokens: r.sum?.totalOutputTokens ?? 0,
      inference_ms: r.sum?.totalInferenceTimeMs ?? 0,
    }));

    const totalNeurons = neuronRows.reduce((s, r) => s + r.neurons, 0);
    const totalRequests = neuronRows.reduce((s, r) => s + r.requests, 0);

    const monthlyAgg = (acct.monthly || [])[0] || { sum: {} };
    const monthlyTotalNeurons = monthlyAgg.sum?.totalNeurons ?? 0;
    const basePlan = 5.0;
    const dailyRows = acct.daily || [];
    let monthlyOverage = 0;
    for (const d of dailyRows) {
      const dayNeurons = d.sum?.totalNeurons ?? 0;
      monthlyOverage += Math.max(0, dayNeurons - 10000);
    }
    const monthlyOverageCost = (monthlyOverage / 1000) * 0.011;
    const avgDailyOverage = dayOfMonth > 0 ? monthlyOverage / dayOfMonth : 0;
    const projOverage = avgDailyOverage * daysInMonth;
    const projCost = basePlan + (projOverage / 1000) * 0.011;

    const invocations = (acct.invocations || []).reduce(
      (acc, r) => {
        acc.requests += r.sum?.requests ?? 0;
        acc.errors += r.sum?.errors ?? 0;
        return acc;
      },
      { requests: 0, errors: 0 }
    );

    return {
      timestamp: now.toISOString(),
      account_id: env.CF_ACCOUNT_ID,
      period: "today_utc",
      period_start: todayStart.toISOString(),
      neurons: {
        total: Math.round(totalNeurons * 100) / 100,
        included: 10000,
        overage: Math.max(0, Math.round((totalNeurons - 10000) * 100) / 100),
        overage_cost_usd: Math.max(0, ((totalNeurons - 10000) / 1000) * 0.011),
        by_model: neuronRows,
      },
      costs: {
        month: now.toISOString().slice(0, 7),
        base_plan_usd: basePlan,
        neurons_total: Math.round(monthlyTotalNeurons * 100) / 100,
        neurons_overage: Math.round(monthlyOverage * 100) / 100,
        neurons_cost_usd: Math.round(monthlyOverageCost * 10000) / 10000,
        month_to_date_usd: Math.round((basePlan + monthlyOverageCost) * 100) / 100,
        projected_month_usd: Math.round(projCost * 100) / 100,
        days_elapsed: dayOfMonth,
        days_in_month: daysInMonth,
      },
      ai_requests: { total: totalRequests },
      worker: {
        name: workerName,
        invocations: invocations.requests,
        errors: invocations.errors,
      },
    };
  } catch (err) {
    return {
      timestamp: new Date().toISOString(),
      error: err.message || "Failed to fetch status",
      neurons: { total: 0, included: 10000, overage: 0, overage_cost_usd: 0, by_model: [] },
      costs: { month: new Date().toISOString().slice(0, 7), base_plan_usd: 5, neurons_total: 0, neurons_overage: 0, neurons_cost_usd: 0, month_to_date_usd: 5, projected_month_usd: 5, days_elapsed: 0, days_in_month: 30 },
      ai_requests: { total: 0 },
      worker: { name: (env.WORKER_NAME || "cng").replace(/[^a-zA-Z0-9_-]/g, ""), invocations: 0, errors: 0 },
    };
  }
}
