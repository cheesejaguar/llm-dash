const LLM_BASE = 'http://127.0.0.1:8001';
const TIMEOUT = 3000;

async function fetchJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(`${LLM_BASE}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function collectLlm() {
  const [health, models, slots, props] = await Promise.allSettled([
    fetchJson('/health'),
    fetchJson('/v1/models'),
    fetchJson('/slots'),
    fetchJson('/props'),
  ]);

  const result = {
    online: health.status === 'fulfilled',
    health: health.status === 'fulfilled' ? health.value : null,
    model: null,
    slots: null,
    props: null,
  };

  if (models.status === 'fulfilled' && models.value.data?.length) {
    result.model = models.value.data[0].id;
  }

  if (slots.status === 'fulfilled') {
    const slotData = Array.isArray(slots.value) ? slots.value : [];
    result.slots = slotData.map(s => ({
      id: s.id,
      state: s.state ?? 0,
      prompt_n: s.n_past ?? s.prompt_n ?? 0,
      decoded_n: s.n_decoded ?? s.decoded_n ?? 0,
      is_processing: s.is_processing ?? false,
    }));
  }

  if (props.status === 'fulfilled') {
    result.props = {
      ctx_size: props.value.default_generation_settings?.n_ctx ?? null,
      n_parallel: props.value.total_slots ?? null,
    };
  }

  return result;
}

module.exports = { collectLlm };
