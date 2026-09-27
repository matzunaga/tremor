(() => {
  "use strict";

  const FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/";
  const SPANS = {
    day: { feed: `${FEED}all_day.geojson`, ms: 86400000, replay: 90, name: "Day", label: "past day", ago: "a day ago" },
    week: { feed: `${FEED}2.5_week.geojson`, ms: 7 * 86400000, replay: 150, name: "Week", label: "past week", ago: "a week ago" }
  };

  const REFRESH_MS = 5 * 60 * 1000;
  const HOLD = 5; // seconds the last echoes are left to fade before the replay begins again
  const HOME_LON = 155; // the map is centred on the Pacific, so the Ring of Fire sits whole
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TAU = Math.PI * 2;

  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");

  const intro = document.getElementById("intro");
  const reading = document.getElementById("reading");
  const startButton = document.getElementById("start");
  const spanToggle = document.getElementById("spanToggle");
  const labelEl = document.getElementById("label");
  const conditionEl = document.getElementById("condition");
  const arrivalEl = document.getElementById("arrival");
  const detailsEl = document.getElementById("details");
  const statusEl = document.getElementById("status");
  const soundToggle = document.getElementById("soundToggle");
  const aboutButton = document.getElementById("aboutButton");
  const aboutPanel = document.getElementById("aboutPanel");
  const closeAbout = document.getElementById("closeAbout");
  const mark = document.getElementById("mark");
  const markCard = document.getElementById("markCard");

  // The glyph lives in its own file so it can be redrawn without touching the code.
  // It is placed inside the button so its lines can follow the mark's color.
  fetch("mark.svg", { cache: "no-cache" })
    .then((response) => (response.ok ? response.text() : Promise.reject()))
    .then((text) => {
      const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
      if (svg.nodeName.toLowerCase() !== "svg") return;
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      mark.replaceChildren(document.importNode(svg, true));
    })
    .catch(() => {
      // no glyph file: the button keeps its label and the page carries on
    });
  const tip = document.getElementById("tip");

  const data = {
    span: "day",
    quakes: [],
    strongest: null,
    generated: 0,
    lastFetch: 0,
    failed: false
  };

  const state = {
    running: false,
    paused: false,
    last: performance.now(),
    clock: 0,
    width: 0,
    height: 0,
    dpr: 1,
    soundOn: false,
    reveal: 0, // 0 before Begin, 1 once the replay runs
    cursor: 0, // the moment of the replay, in ms since the epoch
    next: 0, // index of the next earthquake to strike
    hold: 0,
    fade: 1, // embers of the finished replay fading out
    notable: null,
    hover: null
  };

  const scene = {
    scale: 1,
    mapW: 360,
    mapH: 144,
    top: 0,
    viewLon: HOME_LON,
    wrap: false
  };

  const layers = { map: null, glow: null };
  const echoes = [];

  /* ---------- Map ---------- */

  const MAP = window.MAP;
  const land = (() => {
    const bytes = Uint8Array.from(atob(MAP.bits), (c) => c.charCodeAt(0));
    const at = (i, j) => {
      if (j < 0 || j >= MAP.rows) return false;
      const n = j * MAP.cols + ((i + MAP.cols) % MAP.cols);
      return (bytes[n >> 3] & (1 << (n & 7))) !== 0;
    };
    const dots = [];
    for (let j = 0; j < MAP.rows; j += 1) {
      for (let i = 0; i < MAP.cols; i += 1) {
        if (!at(i, j)) continue;
        // a dot on the shore has sea beside it; it is drawn a little brighter
        const odd = j % 2;
        const coast =
          !at(i - 1, j) || !at(i + 1, j) || !at(i - 1 + odd, j - 1) || !at(i + odd, j - 1) ||
          !at(i - 1 + odd, j + 1) || !at(i + odd, j + 1);
        dots.push({
          lon: -180 + (i + 0.5 + odd * 0.5) * MAP.step,
          lat: MAP.north - (j + 0.5) * MAP.step,
          coast
        });
      }
    }
    return dots;
  })();

  /* ---------- Small helpers ---------- */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const wrap180 = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

  function seeded(n) {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.ceil(w * state.dpr);
    c.height = Math.ceil(h * state.dpr);
    const g = c.getContext("2d");
    g.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    return [c, g];
  }

  // pale amber for a tremor you would barely feel, through orange, to a deep red for a great quake
  const HEAT = [
    [0, [255, 236, 196]],
    [1.5, [255, 222, 150]],
    [3, [255, 186, 70]],
    [4.5, [255, 118, 48]],
    [5.8, [255, 64, 40]],
    [7, [224, 20, 42]],
    [8.5, [200, 8, 40]]
  ];

  function heat(mag) {
    const m = clamp(mag, HEAT[0][0], HEAT[HEAT.length - 1][0]);
    for (let k = 1; k < HEAT.length; k += 1) {
      if (m <= HEAT[k][0]) {
        const [m0, c0] = HEAT[k - 1];
        const [m1, c1] = HEAT[k];
        const t = (m - m0) / (m1 - m0);
        return [0, 1, 2].map((i) => Math.round(mix(c0[i], c1[i], t)));
      }
    }
    return HEAT[HEAT.length - 1][1];
  }

  const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${clamp(a, 0, 1)})`;

  // the widest reach of an echo, in pixels: it grows by half again with each step of magnitude
  function reach(mag) {
    const unit = Math.max(scene.mapW, 900) * 0.004;
    return clamp(unit * Math.pow(1.55, Math.max(0, mag)), 6, scene.mapH * 0.6);
  }

  const ringsFor = (mag) => (mag >= 5 ? 3 : mag >= 3 ? 2 : 1);
  const lifeFor = (mag) => 1.5 + 0.42 * Math.max(0, mag);

  /* ---------- Layout ---------- */

  function resize() {
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.width = window.innerWidth;
    state.height = window.innerHeight;

    canvas.width = Math.floor(state.width * state.dpr);
    canvas.height = Math.floor(state.height * state.dpr);
    canvas.style.width = `${state.width}px`;
    canvas.style.height = `${state.height}px`;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    const w = state.width;
    const h = state.height;
    const span = 360;
    const tall = MAP.rows * MAP.step;
    const portrait = h > w * 1.1;
    scene.portrait = portrait;

    if (portrait) {
      // on phones the map is taller than the screen is wide, and turns under a finger
      scene.scale = Math.max(w / span, (h * 0.46) / tall);
      scene.mapH = tall * scene.scale;
      scene.top = clamp(h * 0.42 - scene.mapH / 2, 70, h * 0.3);
    } else {
      // the map fills the width, unless that would crowd the words above and below it
      const room = h - 70 - 150;
      scene.scale = Math.max(Math.min(w / span, room / tall), (h * 0.4) / tall);
      scene.mapH = tall * scene.scale;
      scene.top = 70 + Math.max(0, (room - scene.mapH) / 2);
    }

    scene.mapW = span * scene.scale;
    scene.wrap = scene.mapW > w + 1;
    if (!scene.wrap) scene.viewLon = HOME_LON;

    paintMap();
    paintGlow();
  }

  const xOf = (lon) => state.width / 2 + wrap180(lon - scene.viewLon) * scene.scale;
  const yOf = (lat) => scene.top + (MAP.north - lat) * scene.scale;

  // every place a point is drawn: once, or again a turn of the map to either side
  function copies(x, margin, fn) {
    fn(x);
    if (!scene.wrap) return;
    if (x - margin < 0) fn(x + scene.mapW);
    if (x + margin > state.width) fn(x - scene.mapW);
  }

  /* The map is painted once, in its own frame from 180° west, and slid into place each frame */
  function paintMap() {
    const W = scene.mapW;
    const H = scene.mapH;
    const pad = 24;
    const [c, g] = makeCanvas(W, H + pad * 2);
    const s = scene.scale;
    const x = (lon) => (lon + 180) * s;
    const y = (lat) => pad + (MAP.north - lat) * s;

    // a deeper sea within the map, fading out at the top and bottom
    const sea = g.createLinearGradient(0, pad, 0, pad + H);
    sea.addColorStop(0, "rgba(22, 40, 78, 0)");
    sea.addColorStop(0.12, "rgba(22, 40, 78, 0.2)");
    sea.addColorStop(0.5, "rgba(24, 46, 90, 0.26)");
    sea.addColorStop(0.88, "rgba(22, 40, 78, 0.2)");
    sea.addColorStop(1, "rgba(22, 40, 78, 0)");
    g.fillStyle = sea;
    g.fillRect(0, pad, W, H);

    // the graticule, every thirty degrees, in the faintest dotted line
    g.fillStyle = "rgba(150, 180, 230, 0.12)";
    const spacing = Math.max(3, s * 1.2);
    for (let lon = -180; lon < 180; lon += 30) {
      for (let py = pad; py < pad + H; py += spacing) g.fillRect(x(lon), py, 0.8, 0.8);
    }
    for (let lat = 60; lat >= -60; lat -= 30) {
      for (let px = 0; px < W; px += spacing) g.fillRect(px, y(lat), 0.8, 0.8);
    }

    // land as a honeycomb of dots, a little brighter along the shore
    const r = Math.max(0.45, MAP.step * s * 0.22);
    land.forEach((dot, n) => {
      const grain = seeded(n + 1);
      // warmer toward the dry middle latitudes, cooler toward the poles
      const warm = smooth(62, 18, Math.abs(dot.lat)) * 0.6 + grain * 0.25;
      const cr = mix(170, 214, warm);
      const cg = mix(190, 196, warm);
      const cb = mix(200, 164, warm);
      // the top rows fade, so the map has no hard edge in the Arctic
      const edge = smooth(MAP.north, MAP.north - 7, dot.lat);
      const a = (dot.coast ? 0.3 : 0.12 + grain * 0.08) * edge;
      g.fillStyle = `rgba(${cr | 0}, ${cg | 0}, ${cb | 0}, ${a})`;
      g.beginPath();
      g.arc(x(dot.lon), y(dot.lat), dot.coast ? r * 1.05 : r, 0, TAU);
      g.fill();
    });

    // the seams between the plates, glowing faintly like cooling iron
    const drawPlates = (width, style) => {
      g.lineWidth = width;
      g.strokeStyle = style;
      g.lineJoin = "round";
      g.lineCap = "round";
      g.beginPath();
      MAP.plates.forEach((line) => {
        for (let k = 0; k < line.length; k += 2) {
          const lon = line[k] / 10;
          const lat = line[k + 1] / 10;
          if (lat > MAP.north + 2) continue;
          const jump = k > 0 && Math.abs(lon - line[k - 2] / 10) > 180;
          if (k === 0 || jump) g.moveTo(x(lon), y(lat));
          else g.lineTo(x(lon), y(lat));
        }
      });
      g.stroke();
    };
    g.save();
    g.filter = `blur(${Math.max(2, s * 0.9)}px)`;
    drawPlates(Math.max(2, s * 0.9), "rgba(255, 96, 48, 0.06)");
    g.restore();
    drawPlates(Math.max(0.5, s * 0.14), "rgba(255, 128, 80, 0.12)");

    layers.map = c;
    layers.mapPad = pad;
  }

  // a soft white glow, tinted when drawn, for the flash where an earthquake strikes
  function paintGlow() {
    const size = 64;
    const [c, g] = makeCanvas(size, size);
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255, 255, 255, 1)");
    grad.addColorStop(0.25, "rgba(255, 255, 255, 0.45)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    layers.glow = c;
    layers.tints = new Map();
  }

  function tinted(color) {
    const key = color.join(",");
    if (!layers.tints.has(key)) {
      const size = 64;
      const [c, g] = makeCanvas(size, size);
      g.drawImage(layers.glow, 0, 0, size, size);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = rgba(color, 1);
      g.fillRect(0, 0, size, size);
      layers.tints.set(key, c);
    }
    return layers.tints.get(key);
  }

  /* ---------- Drawing ---------- */

  function drawBackground() {
    const w = state.width;
    const h = state.height;
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#04050a");
    sky.addColorStop(0.5, "#060a14");
    sky.addColorStop(1, "#04050a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const x0 = xOf(-180);
    const y0 = scene.top - layers.mapPad;
    const W = scene.mapW;
    const drawW = layers.map.width / state.dpr;
    const drawH = layers.map.height / state.dpr;
    let start = x0 % W;
    if (start > 0) start -= W;
    ctx.save();
    if (!scene.wrap) {
      // the whole world fits, so it is drawn once, clipped to its own width
      ctx.beginPath();
      ctx.rect(w / 2 - W / 2, 0, W, h);
      ctx.clip();
    }
    for (let x = start; x < w; x += W) ctx.drawImage(layers.map, x, y0, drawW, drawH);
    ctx.restore();

    if (!scene.wrap && W < w) {
      // and its edges fade into the night
      const edge = W * 0.05;
      [
        [w / 2 - W / 2, w / 2 - W / 2 + edge],
        [w / 2 + W / 2, w / 2 + W / 2 - edge]
      ].forEach(([from, to]) => {
        const fade = ctx.createLinearGradient(from, 0, to, 0);
        fade.addColorStop(0, "rgba(5, 8, 16, 1)");
        fade.addColorStop(1, "rgba(5, 8, 16, 0)");
        ctx.fillStyle = fade;
        ctx.fillRect(Math.min(from, to), y0, edge, drawH);
      });
    }
  }

  function drawEmbers() {
    const base = state.running ? state.fade : 0.55;
    if (base <= 0.001) return;
    const upto = state.running ? state.next : data.quakes.length;
    for (let i = 0; i < upto; i += 1) {
      const q = data.quakes[i];
      const x = xOf(q.lon);
      const y = yOf(q.lat);
      const r = 0.9 + Math.max(0, q.mag) * 0.42;
      const color = heat(q.mag);
      const a = base * (0.35 + Math.min(0.5, q.mag * 0.07));
      copies(x, r * 4, (cx) => {
        if (q.mag >= 4) {
          const g = r * 5;
          ctx.globalAlpha = a * 0.5;
          ctx.drawImage(tinted(color), cx - g, y - g, g * 2, g * 2);
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = rgba(color, a);
        ctx.beginPath();
        ctx.arc(cx, y, r, 0, TAU);
        ctx.fill();
      });
    }
  }

  // Echo: rings leave each earthquake a beat apart, like the drums of Ma, wider and redder the stronger it was
  function drawEchoes() {
    for (let i = echoes.length - 1; i >= 0; i -= 1) {
      const e = echoes[i];
      const age = state.clock - e.born;
      const life = lifeFor(e.mag);
      const rings = ringsFor(e.mag);
      if (age > life + rings * 0.3) {
        echoes.splice(i, 1);
        continue;
      }
      const x = xOf(e.lon);
      const y = yOf(e.lat);
      const R = reach(e.mag);
      const color = heat(e.mag);
      const strength = clamp(0.3 + e.mag * 0.1, 0.3, 1);

      copies(x, R, (cx) => {
        // the flash where it struck
        const flash = 1 - smooth(0, 0.5 + e.mag * 0.12, age);
        if (flash > 0) {
          const g = R * 0.38 + 6;
          ctx.globalAlpha = flash * strength;
          ctx.drawImage(tinted(color), cx - g, y - g, g * 2, g * 2);
          ctx.globalAlpha = 1;
        }

        for (let k = 0; k < rings; k += 1) {
          const u = reduceMotion ? 0.55 : (age - k * 0.3) / life;
          if (u <= 0 || u >= 1) continue;
          const spread = reduceMotion ? 1 : 1 - Math.pow(1 - u, 3);
          const radius = R * (0.08 + spread * 0.92) * (1 - k * 0.08);
          const fade = reduceMotion ? 1 - age / (life + 0.9) : (1 - u) * (1 - u);
          ctx.strokeStyle = rgba(color, fade * strength * (1 - k * 0.22));
          ctx.lineWidth = (0.8 + (1 - u) * (0.6 + e.mag * 0.32)) * (1 - k * 0.2);
          ctx.beginPath();
          ctx.arc(cx, y, radius, 0, TAU);
          ctx.stroke();
        }
      });
    }
  }

  // the name of a strong earthquake, set beside it while its echo lasts
  function drawNotable() {
    const n = state.notable;
    if (!n) return;
    const age = state.clock - n.born;
    const life = lifeFor(n.quake.mag) + 3;
    if (age > life) {
      state.notable = null;
      return;
    }
    const a = smooth(0, 0.4, age) * (1 - smooth(life - 1.2, life, age));
    const q = n.quake;
    const x = xOf(q.lon);
    const y = yOf(q.lat);
    const off = reach(q.mag) * 0.7 + 10;
    const place = shortPlace(q.place).toUpperCase();
    ctx.save();
    ctx.font = `10px ${getComputedStyle(document.body).fontFamily}`;
    // set to the right of the echo, unless it would run off the screen
    const right = x + off + ctx.measureText(place).width < state.width - 12;
    ctx.textAlign = right ? "left" : "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = rgba([239, 233, 220], a * 0.85);
    ctx.fillText(`M ${q.mag.toFixed(1)}`, x + (right ? off : -off), y - 7);
    ctx.fillStyle = rgba([239, 233, 220], a * 0.5);
    ctx.fillText(place, x + (right ? off : -off), y + 7);
    ctx.restore();
  }

  // a hairline under the map, a day or a week long, with a tick for each earthquake so far
  function drawTimeline() {
    if (state.reveal <= 0.01 || !data.quakes.length) return;
    const span = SPANS[data.span];
    const w = state.width;
    const width = Math.min(440, w * (scene.portrait ? 0.7 : 0.4));
    const x0 = w / 2 - width / 2;
    const y = Math.min(scene.top + scene.mapH + 26, state.height - 165);
    const end = data.generated;
    const from = end - span.ms;
    const at = (t) => x0 + clamp((t - from) / span.ms, 0, 1) * width;
    const a = state.reveal;

    ctx.fillStyle = rgba([239, 233, 220], 0.14 * a);
    ctx.fillRect(x0, y, width, 1);

    for (let i = 0; i < state.next; i += 1) {
      const q = data.quakes[i];
      const tall = 2 + Math.max(0, q.mag) * 1.6;
      ctx.fillStyle = rgba(heat(q.mag), (0.25 + q.mag * 0.08) * a * state.fade);
      ctx.fillRect(at(q.time), y - tall, 1, tall);
    }

    ctx.fillStyle = rgba([239, 233, 220], 0.7 * a);
    ctx.fillRect(at(state.cursor) - 0.5, y - 4, 1, 9);

    ctx.font = `10px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textBaseline = "top";
    ctx.fillStyle = rgba([239, 233, 220], 0.4 * a);
    ctx.textAlign = "left";
    ctx.fillText(span.ago.toUpperCase(), x0, y + 9);
    ctx.textAlign = "right";
    ctx.fillText("NOW", x0 + width, y + 9);
  }

  /* ---------- Replay ---------- */

  function restart() {
    const span = SPANS[data.span];
    state.cursor = data.generated - span.ms;
    state.next = 0;
    state.hold = 0;
    state.fade = 1;
    while (state.next < data.quakes.length && data.quakes[state.next].time < state.cursor) state.next += 1;
  }

  function strike(q) {
    echoes.push({ lon: q.lon, lat: q.lat, mag: q.mag, born: state.clock });
    // the strong ones are named: the strongest of the span, and any of magnitude 5.5 or more
    const bar = Math.min(5.5, data.strongest ? data.strongest.mag : 9);
    if (q.mag >= bar - 0.001 && (!state.notable || q.mag >= state.notable.quake.mag - 0.5)) {
      state.notable = { quake: q, born: state.clock };
      arrivalEl.textContent = `M ${q.mag.toFixed(1)} · ${q.place} · ${ago(q.time)}`;
    }
    thump(q.mag);
  }

  function step(dt) {
    if (!data.quakes.length) return;
    const span = SPANS[data.span];
    const end = data.generated;

    if (state.cursor >= end) {
      state.hold += dt;
      state.fade = 1 - smooth(HOLD - 2, HOLD, state.hold);
      if (state.hold >= HOLD) restart();
      return;
    }

    state.cursor = Math.min(end, state.cursor + (dt * span.ms) / span.replay);
    while (state.next < data.quakes.length && data.quakes[state.next].time <= state.cursor) {
      strike(data.quakes[state.next]);
      state.next += 1;
    }
  }

  /* ---------- Frame ---------- */

  function frame(now) {
    const dt = Math.min(0.1, (now - state.last) / 1000);
    state.last = now;
    render(dt);
    requestAnimationFrame(frame);
  }

  function render(dt) {
    const live = state.running && !state.paused;
    if (live) {
      state.clock += dt;
      step(dt);
    }
    state.reveal = mix(state.reveal, state.running ? 1 : 0, 1 - Math.exp(-dt * 2));

    drawBackground();
    ctx.globalCompositeOperation = "lighter";
    drawEmbers();
    drawEchoes();
    ctx.globalCompositeOperation = "source-over";
    drawNotable();
    drawTimeline();

    if (live) statusEl.textContent = statusText();
  }

  /* ---------- Data ---------- */

  async function loadData() {
    const span = data.span;
    try {
      const response = await fetch(SPANS[span].feed, { cache: "no-cache" });
      if (!response.ok) throw new Error(response.status);
      const json = await response.json();
      if (span !== data.span) return;

      data.quakes = json.features
        .filter((f) => f.properties.mag !== null && f.geometry)
        .map((f) => ({
          id: f.id,
          time: f.properties.time,
          mag: f.properties.mag,
          place: f.properties.place || "Somewhere unnamed",
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          depth: f.geometry.coordinates[2]
        }))
        .sort((a, b) => a.time - b.time);
      data.generated = json.metadata.generated || Date.now();
      data.strongest = data.quakes.reduce((best, q) => (!best || q.mag > best.mag ? q : best), null);
      data.lastFetch = Date.now();
      data.failed = false;

      // on a narrow screen the map opens on the strongest earthquake
      if (scene.wrap && data.strongest && !state.panned) scene.viewLon = data.strongest.lon;

      // a new span always replays from its start; a refresh keeps the replay where it is
      const fresh = state.fromStart || !state.running || state.cursor < data.generated - SPANS[span].ms;
      state.fromStart = false;
      if (fresh) restart();
      else {
        // keep the replay where it is, in the new list
        state.next = data.quakes.findIndex((q) => q.time > state.cursor);
        if (state.next < 0) state.next = data.quakes.length;
      }
      renderReading();
    } catch (error) {
      data.failed = true;
      statusEl.textContent = "The seismographs can't be reached. Trying again soon.";
    }
  }

  function renderReading() {
    const span = SPANS[data.span];
    labelEl.textContent = `Earthquakes, ${span.label}`;
    conditionEl.textContent = condition();
    const s = data.strongest;
    detailsEl.innerHTML = "";
    const parts = [
      `${data.quakes.length} ${data.quakes.length === 1 ? "tremor" : "tremors"}`,
      s ? `strongest M ${s.mag.toFixed(1)}` : "none strong",
      `USGS, ${ago(data.generated)}`
    ];
    parts.forEach((text) => {
      const el = document.createElement("span");
      el.textContent = text;
      detailsEl.append(el);
    });
    if (!state.notable && s) arrivalEl.textContent = `Strongest: M ${s.mag.toFixed(1)} · ${s.place}`;
    if (!state.running) statusEl.textContent = "Press Begin to replay the " + span.label + ".";
  }

  function condition() {
    const m = data.strongest ? data.strongest.mag : 0;
    const when = data.span === "day" ? "today" : "this week";
    if (m >= 7) return `A great earthquake has shaken the Earth ${when}.`;
    if (m >= 6) return `A strong earthquake has struck ${when}.`;
    if (m >= 5) return `The ground has shaken hard somewhere ${when}.`;
    if (m >= 4) return "The Earth is trembling in its usual places.";
    return "The Earth is murmuring quietly.";
  }

  function statusText() {
    const span = SPANS[data.span];
    if (!data.quakes.length) return "Listening to the seismographs.";
    if (state.cursor >= data.generated) return `The ${span.label}, replayed. Again in a moment.`;
    return `Replaying the ${span.label} · ${ago(state.cursor)}`;
  }

  function ago(t) {
    const minutes = Math.max(0, (Date.now() - t) / 60000);
    if (minutes < 1.5) return "just now";
    if (minutes < 90) return `${Math.round(minutes)} minutes ago`;
    const hours = minutes / 60;
    if (hours < 36) return `${Math.round(hours)} ${Math.round(hours) === 1 ? "hour" : "hours"} ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  // "12 km SSW of Pāhala, Hawaii" becomes "Pāhala, Hawaii"
  const shortPlace = (place) => place.replace(/^[\d.]+\s*km\s+[NSEW]{1,3}\s+of\s+/i, "");

  function refreshIfStale() {
    if (document.hidden) return;
    if (Date.now() - data.lastFetch > REFRESH_MS) loadData();
  }

  /* ---------- Sound ---------- */

  const audio = { ctx: null, master: null, noise: null, last: 0 };

  function initAudio() {
    if (audio.ctx) return;
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const length = ac.sampleRate * 3;
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const out = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; // brown noise
      out[i] = last * 3.5;
    }

    const compressor = ac.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 4;
    const master = ac.createGain();
    master.gain.value = 0;
    master.connect(compressor);
    compressor.connect(ac.destination);
    Object.assign(audio, { ctx: ac, master, noise: buffer });
  }

  // a soft, low knock for each earthquake, and a long rumble under the strong ones
  function thump(mag) {
    if (!audio.ctx || !state.soundOn) return;
    const ac = audio.ctx;
    const now = ac.currentTime;
    if (mag < 3 && now - audio.last < 0.09) return;
    audio.last = now;

    const m = Math.max(0, mag);
    const level = clamp(0.03 + 0.018 * Math.pow(m, 1.4), 0.03, 0.5);
    const decay = 0.35 + m * 0.28;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150 - m * 13, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(28, 70 - m * 6), now + decay);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    osc.connect(gain);
    gain.connect(audio.master);
    osc.start(now);
    osc.stop(now + decay + 0.05);

    if (m >= 4.5) {
      const source = ac.createBufferSource();
      source.buffer = audio.noise;
      const filter = ac.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 90 + m * 12;
      const rumble = ac.createGain();
      const long = Math.min(2.9, 0.8 + (m - 4.5) * 0.8);
      rumble.gain.setValueAtTime(0.0001, now);
      rumble.gain.exponentialRampToValueAtTime(clamp((m - 4) * 0.22, 0.05, 0.8), now + 0.15);
      rumble.gain.exponentialRampToValueAtTime(0.0001, now + long);
      source.connect(filter);
      filter.connect(rumble);
      rumble.connect(audio.master);
      source.start(now);
      source.stop(now + long + 0.05);
    }
  }

  function updateSound() {
    if (!audio.ctx) return;
    const on = state.soundOn && state.running && !state.paused;
    audio.master.gain.setTargetAtTime(on ? 0.9 : 0, audio.ctx.currentTime, on ? 0.3 : 0.1);
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    soundToggle.textContent = `Sound: ${state.soundOn ? "On" : "Off"}`;
    soundToggle.setAttribute("aria-pressed", String(state.soundOn));
    if (state.soundOn) {
      initAudio();
      if (audio.ctx.state === "suspended") audio.ctx.resume();
    }
    updateSound();
  }

  /* ---------- Pointing and turning ---------- */

  function nearest(px, py) {
    const upto = state.running ? state.next : data.quakes.length;
    let best = null;
    let bestD = 14 * 14;
    for (let i = 0; i < upto; i += 1) {
      const q = data.quakes[i];
      const y = yOf(q.lat);
      copies(xOf(q.lon), 20, (x) => {
        const d = (x - px) ** 2 + (y - py) ** 2 - q.mag * 4; // the strong ones win a close call
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      });
    }
    return best;
  }

  function showTip(q, px, py) {
    if (!q) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = "";
    const title = document.createElement("strong");
    title.textContent = `M ${q.mag.toFixed(1)}`;
    const place = document.createElement("span");
    place.textContent = q.place;
    const more = document.createElement("span");
    more.textContent = ` · ${ago(q.time)} · ${Math.round(q.depth)} km deep`;
    tip.append(title, place, more);
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${clamp(px + 14, 8, state.width - w - 8)}px`;
    tip.style.top = `${clamp(py - h - 10, 8, state.height - h - 8)}px`;
  }

  const drag = { on: false, x: 0, lon: 0, moved: false };

  canvas.addEventListener("pointerdown", (event) => {
    drag.on = true;
    drag.moved = false;
    drag.x = event.clientX;
    drag.lon = scene.viewLon;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (drag.on && scene.wrap) {
      const dx = event.clientX - drag.x;
      if (Math.abs(dx) > 4) drag.moved = true;
      if (drag.moved) {
        scene.viewLon = wrap180(drag.lon - dx / scene.scale);
        state.panned = true;
        tip.hidden = true;
        return;
      }
    }
    if (event.pointerType === "mouse" && !drag.on) {
      showTip(nearest(event.clientX, event.clientY), event.clientX, event.clientY);
    }
  });

  canvas.addEventListener("pointerup", (event) => {
    drag.on = false;
    if (!drag.moved && event.pointerType !== "mouse") {
      showTip(nearest(event.clientX, event.clientY), event.clientX, event.clientY);
    }
  });

  canvas.addEventListener("pointercancel", () => {
    drag.on = false;
  });

  canvas.addEventListener("pointerleave", () => {
    if (!drag.on) tip.hidden = true;
  });

  /* ---------- Controls ---------- */

  function begin() {
    if (state.running) return;
    state.running = true;
    state.paused = false;
    reading.hidden = false;
    detailsEl.hidden = false;
    void reading.offsetWidth; // lay out the reading first so it fades in
    document.body.classList.add("running");
    startButton.textContent = "Pause";
    echoes.length = 0;
    restart();
    updateSound();
  }

  // one button: Begin, then Pause and Resume
  function togglePause() {
    if (!state.running) {
      begin();
      return;
    }
    state.paused = !state.paused;
    startButton.textContent = state.paused ? "Resume" : "Pause";
    statusEl.textContent = state.paused ? "The ground is held still." : statusText();
    updateSound();
  }

  function toggleSpan() {
    data.span = data.span === "day" ? "week" : "day";
    spanToggle.textContent = `Span: ${SPANS[data.span].name}`;
    document.querySelector(".instruction").innerHTML =
      `The ground is never still.<br />Watch a ${data.span} of it tremble.`;
    data.quakes = [];
    data.strongest = null;
    state.fromStart = true;
    state.next = 0;
    echoes.length = 0;
    state.notable = null;
    arrivalEl.textContent = "";
    statusEl.textContent = "Listening to the seismographs.";
    loadData();
  }

  let hideTimer = null;

  function showControls() {
    document.body.classList.add("controls-visible");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => document.body.classList.remove("controls-visible"), 3500);
  }

  function toggleAbout(force) {
    const open = typeof force === "boolean" ? force : aboutPanel.hidden;
    aboutPanel.hidden = !open;
    aboutButton.setAttribute("aria-expanded", String(open));
    if (open) closeAbout.focus();
    else aboutButton.focus();
  }

  function toggleMark(force) {
    const open = typeof force === "boolean" ? force : markCard.hidden;
    markCard.hidden = !open;
    mark.setAttribute("aria-expanded", String(open));
  }

  startButton.addEventListener("click", togglePause);
  spanToggle.addEventListener("click", toggleSpan);
  soundToggle.addEventListener("click", toggleSound);
  aboutButton.addEventListener("click", () => toggleAbout());
  closeAbout.addEventListener("click", () => toggleAbout(false));
  mark.addEventListener("click", () => toggleMark());

  // the meaning card closes with Escape or a click anywhere outside it
  window.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#markCard, #mark")) toggleMark(false);
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !event.repeat) {
      event.preventDefault();
      togglePause();
    }
    if (event.key === "Escape") {
      if (!aboutPanel.hidden) toggleAbout(false);
      toggleMark(false);
      tip.hidden = true;
    }
  });

  let lastMove = 0;
  window.addEventListener("mousemove", () => {
    if (!state.running || Date.now() - lastMove < 200) return;
    lastMove = Date.now();
    showControls();
  });
  window.addEventListener("touchstart", () => state.running && showControls(), { passive: true });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  // for tuning: ?debug exposes the data and can fast-forward the replay, e.g. __advance(20)
  if (location.search.includes("debug")) {
    window.__data = data;
    window.__state = state;
    window.__echoes = echoes;
    window.__advance = (seconds) => {
      for (let i = 0; i < seconds * 30; i += 1) render(1 / 30);
    };
  }

  resize();
  requestAnimationFrame((now) => {
    state.last = now;
    frame(now);
  });

  loadData();
  setInterval(refreshIfStale, 60 * 1000);
  document.addEventListener("visibilitychange", refreshIfStale);
})();
