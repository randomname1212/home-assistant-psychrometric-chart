/*
 * Psychrometric frequency chart for Home Assistant Lovelace.
 *
 * The card reads paired temperature/relative-humidity recorder statistics and
 * draws a frequency heatmap.  It has no runtime dependencies and can therefore
 * be copied to /config/www on any Home Assistant installation.
 *
 * Important coordinate choice:
 *   - X is dry-bulb temperature (°C).
 *   - Y is absolute humidity (g/m³), as this is the quantity users most often
 *     compare between rooms.
 *   - The right-hand secondary scale shows the equivalent humidity ratio
 *     (g/kg dry air) at a documented reference temperature.  Humidity ratio is
 *     temperature-dependent when converted from a fixed absolute humidity, so
 *     the reference temperature is deliberately shown in the axis title.
 */

const PSY_CARD = "psychrometric-chart-card";

// Recorder resolution is finer for short periods and hourly for long periods.
const PSY_DEFAULT_RANGES = {
  "1d": { label: "1 day", hours: 24, period: "5minute", weight: 1 / 12 },
  "1w": { label: "1 week", hours: 24 * 7, period: "5minute", weight: 1 / 12 },
  "1m": { label: "1 month", months: 1, period: "hour", weight: 1 },
  "6m": { label: "6 months", months: 6, period: "hour", weight: 1 },
  "12m": { label: "12 months", months: 12, period: "hour", weight: 1 },
  custom: { label: "Custom" },
};

// Format a local Date for a native <input type="date"> without UTC shifting.
function psyDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/* -------------------------------------------------------------------------
 * Psychrometric calculations
 * ---------------------------------------------------------------------- */

// Saturation vapour pressure in kPa (Magnus form, with an ice correction).
function psySatPressure(temperatureC) {
  return temperatureC >= 0
    ? 0.61078 * Math.exp((17.2694 * temperatureC) / (temperatureC + 237.29))
    : 0.61078 * Math.exp((21.8746 * temperatureC) / (temperatureC + 265.5));
}

// Station pressure in kPa from altitude using the standard-atmosphere model.
function psyPressureAtAltitude(altitudeM, seaLevelPressureKpa = 101.325) {
  const base = Math.max(0.01, 1 - 2.25577e-5 * altitudeM);
  return seaLevelPressureKpa * Math.pow(base, 5.25588);
}

// Water-vapour density (absolute humidity) in g/m³ from T and fractional RH.
function psyAbsoluteHumidity(temperatureC, relativeHumidity) {
  const vapourPressureKpa = Math.max(0, Math.min(1, relativeHumidity))
    * psySatPressure(temperatureC);
  return (2166.79 * vapourPressureKpa) / (temperatureC + 273.15);
}

// Humidity ratio in g/kg dry air from T, fractional RH and station pressure.
function psyHumidityRatio(temperatureC, relativeHumidity, pressureKpa) {
  const vapourPressureKpa = Math.max(0, Math.min(1, relativeHumidity))
    * psySatPressure(temperatureC);
  return (621.98 * vapourPressureKpa)
    / Math.max(0.001, pressureKpa - vapourPressureKpa);
}

// Convert a plotted absolute humidity back to humidity ratio at a reference T.
function psyRatioFromAbsolute(temperatureC, absoluteHumidity, pressureKpa) {
  const vapourPressureKpa = absoluteHumidity * (temperatureC + 273.15) / 2166.79;
  return (621.98 * vapourPressureKpa)
    / Math.max(0.001, pressureKpa - vapourPressureKpa);
}

// Recover RH (%) for tooltips from a chart coordinate.
function psyRhFromAbsolute(temperatureC, absoluteHumidity) {
  const vapourPressureKpa = absoluteHumidity * (temperatureC + 273.15) / 2166.79;
  return Math.max(0, Math.min(100,
    100 * vapourPressureKpa / psySatPressure(temperatureC)));
}

// Escape configuration text before inserting it into the shadow DOM.
function psyEsc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

class PsychrometricChartCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("psychrometric-chart-card-editor");
  }

  static getStubConfig() {
    return {
      title: "Psychrometric frequency",
      series: [{
        name: "Outside air",
        temperature: "sensor.outsideair_temperature",
        humidity: "sensor.outsideair_humidity",
        default_visible: true,
      }],
    };
  }

  /* Validate and normalise the Lovelace YAML configuration. */
  setConfig(config) {
    if (!config || !Array.isArray(config.series) || !config.series.length) {
      throw new Error("psychrometric-chart-card: `series` must contain at least one temperature/humidity pair");
    }
    const series = config.series.map((item) => ({ ...item }));
    if (series.some((item) => !item.temperature || !item.humidity)) {
      throw new Error("psychrometric-chart-card: each series needs `temperature` and `humidity`");
    }

    this.config = {
      title: "Psychrometric frequency",
      altitude: 0,
      sea_level_pressure: 101.325,
      pressure: null,
      humidity_ratio_reference_temperature: 20,
      min_temperature: -10,
      max_temperature: 40,
      min_absolute_humidity: 0,
      max_absolute_humidity: 25,
      temperature_bin: 0.5,
      absolute_humidity_bin: 0.25,
      default_range: "12m",
      default_colour_mode: "original",
      default_axis_mode: "auto_both",
      ...config,
      series,
    };

    // Preserve an existing selection across a dashboard refresh.  On first use,
    // only entries marked default_visible are shown; otherwise the first is used.
    const validIndexes = new Set(series.map((_, index) => index));
    const previous = this._selectedIndexes
      ? [...this._selectedIndexes].filter((index) => validIndexes.has(index))
      : [];
    const configured = series
      .map((item, index) => (item.default_visible ? index : null))
      .filter((index) => index !== null);
    this._selectedIndexes = new Set(previous.length ? previous
      : (configured.length ? configured : [0]));

    // Two display modes are supported: the original shared multi-colour ramp,
    // or one user-selectable single-hue gradient for each sensor.
    const requestedColourMode = this._colourMode || this.config.default_colour_mode;
    this._colourMode = ["original", "sensor"].includes(requestedColourMode)
      ? requestedColourMode : "original";
    this._readColourPreferences();

    this._range = PSY_DEFAULT_RANGES[this._range]
      ? this._range : this.config.default_range;
    if (!PSY_DEFAULT_RANGES[this._range]) this._range = "12m";
    // Custom date controls are initialised to the most recent month and then
    // retained while the user switches between preset and custom ranges.
    const today = new Date();
    const oneMonthAgo = new Date(today.getTime() - 30 * 24 * 3600000);
    this._customStart = this._customStart || psyDateInputValue(oneMonthAgo);
    this._customEnd = this._customEnd || psyDateInputValue(today);
    this._readAxisPreferences();
    this._data = null;
    this._live = [];
    this._error = null;
    this._loading = false;
    this._loadKey = null;
    this._serverColoursAsked = false;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._build();
    if (this._hass) this._load();
  }

  /* Home Assistant supplies a new `hass` object whenever entity state changes. */
  set hass(hass) {
    this._hass = hass;
    if (!this.config) return;
    if (!this._serverColoursAsked) {
      this._serverColoursAsked = true;
      this._readServerColourPreferences();
    }
    this._updateLive();
    if (!this._data && !this._loading) this._load();
  }

  connectedCallback() {
    // Redraw when the panel width changes so axes remain legible on phones.
    if (!this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this._draw());
      this._resizeObserver.observe(this);
    }
  }

  disconnectedCallback() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }

  getCardSize() { return 10; }

  _selectedSeries() {
    return [...this._selectedIndexes]
      .sort((a, b) => a - b)
      .map((index) => ({ index, ...this.config.series[index] }));
  }

  // Use a configured station pressure, or calculate it from altitude.
  _pressure() {
    const explicit = Number(this.config.pressure);
    if (this.config.pressure !== null && Number.isFinite(explicit) && explicit > 0) {
      return explicit;
    }
    return psyPressureAtAltitude(
      Number(this.config.altitude) || 0,
      Number(this.config.sea_level_pressure) || 101.325,
    );
  }

  // Default hues are intentionally stable so a sensor keeps its identity.
  _sensorColour(index) {
    // Entity-based defaults remain correct even when YAML series are reordered.
    const entityDefaults = {
      "sensor.outsideair_temperature": "#f44336",      // red
      "sensor.livingroom_temperature": "#4caf50",      // green
      "sensor.kitchen_temperature": "#009688",         // teal
      "sensor.hallway_temperature": "#ff9800",         // orange
      "sensor.masterbedroom_temperature": "#3f51b5",   // indigo
      "sensor.smallbedroom_temperature": "#2196f3",    // blue
      "sensor.bathroom_temperature": "#e91e63",        // pink
      "sensor.ensuite_temperature": "#9c27b0",         // purple
      "sensor.baywindowseat_temperature": "#6d4c41",   // neutral brown
    };
    const fallbackPalette = ["#1976d2", "#e53935", "#8e24aa", "#fb8c00", "#00acc1"];
    return this._colourPreferences?.[index]
      || this.config.series[index]?.color
      || entityDefaults[this.config.series[index]?.temperature]
      || fallbackPalette[index % fallbackPalette.length];
  }

  // Colour choices are presentation preferences, so browser-local persistence
  // avoids modifying the Lovelace YAML whenever a user experiments with hues.
  _readColourPreferences() {
    this._colourPreferences = {};
    try {
      const stored = JSON.parse(localStorage.getItem("psychrometric_chart_sensor_colours") || "{}");
      this.config.series.forEach((item, index) => {
        const value = stored[item.temperature];
        if (/^#[0-9a-f]{6}$/i.test(value || "")) this._colourPreferences[index] = value;
      });
    } catch (error) {
      // A disabled/full localStorage must never stop the chart from rendering.
    }
  }

  _saveSensorColour(index, colour) {
    this._colourPreferences[index] = colour;
    try {
      const stored = JSON.parse(localStorage.getItem("psychrometric_chart_sensor_colours") || "{}");
      stored[this.config.series[index].temperature] = colour;
      localStorage.setItem("psychrometric_chart_sensor_colours", JSON.stringify(stored));
    } catch (error) {
      // Keep the in-memory choice when localStorage is unavailable.
    }
    this._writeServerColourPreferences();
  }

  // Home Assistant user data makes colours survive cache clearing and follow
  // the signed-in HA user to another browser. Local storage remains a fast
  // offline fallback while this asynchronous request completes.
  async _readServerColourPreferences() {
    if (!this._hass) return;
    try {
      const response = await this._hass.callWS({
        type: "frontend/get_user_data",
        key: "psychrometric_chart_sensor_colours",
      });
      const stored = response?.value || {};
      this.config.series.forEach((item, index) => {
        const colour = stored[item.temperature];
        if (/^#[0-9a-f]{6}$/i.test(colour || "")) this._colourPreferences[index] = colour;
      });
      this._els?.toggles.querySelectorAll("input.sensor-colour").forEach((input) => {
        input.value = this._sensorColour(Number(input.dataset.index));
      });
      this._renderLegend();
      this._draw();
    } catch (error) {
      // Older HA versions may not expose frontend user data; local persistence
      // still provides the requested behaviour in that case.
    }
  }

  _writeServerColourPreferences() {
    if (!this._hass) return;
    const value = {};
    this.config.series.forEach((item, index) => {
      value[item.temperature] = this._sensorColour(index);
    });
    this._hass.callWS({
      type: "frontend/set_user_data",
      key: "psychrometric_chart_sensor_colours",
      value,
    }).catch(() => {});
  }

  // Axis settings are dashboard presentation preferences. Keeping them in
  // local storage makes manual fixed bounds survive ordinary browser reloads.
  _readAxisPreferences() {
    const allowedModes = ["auto_both", "auto_temperature", "auto_humidity", "fixed", "default"];
    const defaults = {
      mode: this.config.default_axis_mode,
      temperatureMin: Number(this.config.min_temperature),
      temperatureMax: Number(this.config.max_temperature),
      absoluteMin: Number(this.config.min_absolute_humidity),
      absoluteMax: Number(this.config.max_absolute_humidity),
    };
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem("psychrometric_chart_axis_settings") || "{}");
    } catch (error) {
      // Malformed/disabled storage falls back to the Lovelace configuration.
    }
    this._axisMode = allowedModes.includes(this._axisMode || stored.mode)
      ? (this._axisMode || stored.mode) : defaults.mode;
    if (!allowedModes.includes(this._axisMode)) this._axisMode = "auto_both";
    this._fixedBounds = {
      temperatureMin: Number.isFinite(Number(stored.temperatureMin)) ? Number(stored.temperatureMin) : defaults.temperatureMin,
      temperatureMax: Number.isFinite(Number(stored.temperatureMax)) ? Number(stored.temperatureMax) : defaults.temperatureMax,
      absoluteMin: Number.isFinite(Number(stored.absoluteMin)) ? Number(stored.absoluteMin) : defaults.absoluteMin,
      absoluteMax: Number.isFinite(Number(stored.absoluteMax)) ? Number(stored.absoluteMax) : defaults.absoluteMax,
    };
  }

  _saveAxisPreferences() {
    try {
      localStorage.setItem("psychrometric_chart_axis_settings", JSON.stringify({
        mode: this._axisMode,
        ...this._fixedBounds,
      }));
    } catch (error) {
      // In-memory settings remain active when local storage is unavailable.
    }
  }

  /* -----------------------------------------------------------------------
   * DOM construction and controls
   * -------------------------------------------------------------------- */

  _build() {
    const root = this.shadowRoot;
    root.replaceChildren();
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; }
      ha-card { overflow: hidden; }
      .head { display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px; padding:14px 16px 8px; }
      .title { font-size:18px; font-weight:500; color:var(--primary-text-color); margin-right:auto; }
      select, button { box-sizing:border-box; height:34px; border-radius:8px; border:1px solid var(--divider-color);
        background:var(--card-background-color); color:var(--primary-text-color); font:inherit; font-size:13px; padding:0 9px; }
      button { cursor:pointer; display:inline-flex; align-items:center; gap:5px; }
      button:hover { background:var(--secondary-background-color); }
      button ha-icon { --mdc-icon-size:18px; }
      .custom-range { display:flex; align-items:center; flex-wrap:wrap; gap:6px 10px;
        padding:0 16px 9px; color:var(--secondary-text-color); font-size:12px; }
      .custom-range[hidden] { display:none; }
      .custom-range label { display:inline-flex; align-items:center; gap:5px; }
      .custom-range input { box-sizing:border-box; height:32px; border-radius:7px;
        border:1px solid var(--divider-color); background:var(--card-background-color);
        color:var(--primary-text-color); font:inherit; padding:0 7px; color-scheme:dark light; }
      .axis-controls { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap;
        gap:6px 10px; min-height:32px; padding:0 16px 9px;
        color:var(--secondary-text-color); font-size:12px; }
      /* Keep the row in the layout when inactive so changing scale mode never
         shifts the graph vertically; only its visible contents are toggled. */
      .axis-controls.is-hidden { visibility:hidden; pointer-events:none; }
      .axis-controls label { display:inline-flex; align-items:center; gap:5px; }
      .axis-controls input { box-sizing:border-box; width:76px; height:32px; border-radius:7px;
        border:1px solid var(--divider-color); background:var(--card-background-color);
        color:var(--primary-text-color); font:inherit; padding:0 7px; }
      .series-toggles { padding:0 16px 9px; overflow-x:auto; }
      .series-table { width:100%; border-collapse:collapse; color:var(--primary-text-color); font-size:12px; }
      .series-table th, .series-table td { padding:4px 8px; border-bottom:1px solid var(--divider-color); text-align:left; }
      .series-table th { color:var(--secondary-text-color); font-weight:500; }
      .series-table td:first-child, .series-table th:first-child { width:34px; text-align:center; }
      .series-table td:nth-child(2), .series-table th:nth-child(2) { width:42px; text-align:center; }
      .series-table .sensor-cell { display:flex; align-items:center; gap:8px; }
      .series-table input.visibility { margin:0; accent-color:var(--primary-color); }
      .series-toggle input.sensor-colour { width:18px; height:18px; padding:0; border:0;
        border-radius:50%; background:transparent; cursor:pointer; }
      .series-toggle input.sensor-colour::-webkit-color-swatch-wrapper { padding:1px; }
      .series-toggle input.sensor-colour::-webkit-color-swatch { border:0; border-radius:50%; }
      .status { display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px; padding:0 16px 8px;
        color:var(--secondary-text-color); font-size:12px; min-height:18px; }
      .live { display:inline-flex; align-items:center; gap:6px; }
      .dot { width:9px; height:9px; border-radius:50%; background:#ff3d8d;
        box-shadow:0 0 0 2px color-mix(in srgb, #ff3d8d 28%, transparent); }
      .status .spacer { flex:1; }
      .error { color:var(--error-color); }
      .chart-wrap { position:relative; width:100%; min-height:440px; }
      svg { display:block; width:100%; min-height:440px; touch-action:none; }
      .tooltip { position:absolute; z-index:3; pointer-events:none; display:none; max-width:245px;
        padding:8px 10px; border-radius:8px; background:rgba(24,27,34,.94); color:#fff;
        font-size:12px; line-height:1.45; box-shadow:0 4px 14px rgba(0,0,0,.3); }
      .tooltip strong { font-size:13px; }
      .foot { display:flex; align-items:center; flex-wrap:wrap; gap:8px 16px; padding:7px 16px 14px;
        color:var(--secondary-text-color); font-size:11px; }
      .legend { display:inline-flex; align-items:center; gap:7px; }
      .gradient-legend { display:flex; align-items:center; flex-wrap:wrap; gap:6px 12px; }
      .sensor-ramp { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
      .sensor-ramp i { width:72px; height:9px; border-radius:5px; }
      .ramp { width:130px; height:9px; border-radius:5px;
        background:linear-gradient(90deg, rgba(32,146,255,.12), #16a5ff, #5d43ff, #c52bda, #ff6a1a); }
      .empty { opacity:.8; }
      @media (max-width:600px) {
        .head { padding:11px 10px 6px; gap:6px; }
        .title { width:100%; font-size:16px; }
        .series-toggles, .status { padding-left:10px; padding-right:10px; }
        .custom-range { padding-left:10px; padding-right:10px; }
        .axis-controls { padding-left:10px; padding-right:10px; }
        .chart-wrap, svg { min-height:390px; }
        .foot { padding:6px 10px 11px; }
      }
    `;
    root.append(style);

    const card = document.createElement("ha-card");
    card.innerHTML = `
      <div class="head">
        <div class="title">${psyEsc(this.config.title)}</div>
        <select class="colour-mode" aria-label="Frequency colour scheme">
          <option value="original">Original colours</option>
          <option value="sensor">Per-sensor colours</option>
        </select>
        <select class="range" aria-label="History period"></select>
        <select class="axis-mode" aria-label="Axis scale mode">
          <option value="auto_both">Auto scale both axes</option>
          <option value="auto_temperature">Auto scale temperature</option>
          <option value="auto_humidity">Auto scale humidity</option>
          <option value="fixed">Fixed custom scales</option>
          <option value="default">Default scale (original)</option>
        </select>
        <button class="refresh" title="Refresh statistics"><ha-icon icon="mdi:refresh"></ha-icon> Refresh</button>
      </div>
      <div class="custom-range" hidden>
        <label>Start <input class="custom-start" type="date"></label>
        <label>End <input class="custom-end" type="date"></label>
      </div>
      <div class="axis-controls is-hidden" aria-hidden="true">
        <label>Temperature min <input class="axis-temperature-min" type="number" step="0.5"> °C</label>
        <label>Temperature max <input class="axis-temperature-max" type="number" step="0.5"> °C</label>
        <label>Absolute humidity min <input class="axis-absolute-min" type="number" step="0.25"> g/m³</label>
        <label>Absolute humidity max <input class="axis-absolute-max" type="number" step="0.25"> g/m³</label>
      </div>
      <div class="status"><span class="live"><i class="dot"></i><span class="live-text">Live: —</span></span><span class="spacer"></span><span class="summary"></span></div>
      <div class="chart-wrap"><svg role="img" aria-label="Psychrometric frequency chart"></svg><div class="tooltip"></div></div>
      <div class="foot"><div class="gradient-legend"></div><span>Light/faded means less frequent; bright/intense means more frequent.</span></div>
      <div class="series-toggles" aria-label="Visible air sensors">
        <table class="series-table">
          <thead><tr><th>No.</th><th>Show</th><th>Sensor and colour</th></tr></thead>
          <tbody class="series-body"></tbody>
        </table>
      </div>
    `;
    root.append(card);
    this._els = {
      toggles: card.querySelector(".series-toggles"),
      seriesBody: card.querySelector(".series-body"),
      colourMode: card.querySelector(".colour-mode"),
      range: card.querySelector(".range"),
      axisMode: card.querySelector(".axis-mode"),
      axisControls: card.querySelector(".axis-controls"),
      axisTemperatureMin: card.querySelector(".axis-temperature-min"),
      axisTemperatureMax: card.querySelector(".axis-temperature-max"),
      axisAbsoluteMin: card.querySelector(".axis-absolute-min"),
      axisAbsoluteMax: card.querySelector(".axis-absolute-max"),
      customRange: card.querySelector(".custom-range"),
      customStart: card.querySelector(".custom-start"),
      customEnd: card.querySelector(".custom-end"),
      refresh: card.querySelector(".refresh"),
      live: card.querySelector(".live-text"),
      summary: card.querySelector(".summary"),
      wrap: card.querySelector(".chart-wrap"),
      svg: card.querySelector("svg"),
      tooltip: card.querySelector(".tooltip"),
      gradientLegend: card.querySelector(".gradient-legend"),
    };

    // The visible row number is generated from the series array index, so the
    // table automatically expands to 10, 11, etc. when more sensors are added.
    this.config.series.forEach((item, index) => {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${index + 1}</td><td><input class="visibility" type="checkbox" value="${index}" ${this._selectedIndexes.has(index) ? "checked" : ""}></td><td><span class="sensor-cell"><input class="sensor-colour" type="color" value="${this._sensorColour(index)}" data-index="${index}" title="Choose ${psyEsc(item.name || `Air source ${index + 1}`)} colour"><span>${psyEsc(item.name || `Air source ${index + 1}`)}</span></span></td>`;
      this._els.seriesBody.append(row);
    });
    this._els.toggles.addEventListener("change", (event) => {
      const colourInput = event.target.closest("input.sensor-colour");
      if (colourInput) {
        this._saveSensorColour(Number(colourInput.dataset.index), colourInput.value);
        this._renderLegend();
        this._draw();
        return;
      }
      const input = event.target.closest("input.visibility");
      if (!input) return;
      const index = Number(input.value);
      if (input.checked) this._selectedIndexes.add(index);
      else this._selectedIndexes.delete(index);
      this._data = null;
      this._loadKey = null;
      this._updateLive();
      this._renderLegend();
      this._load(true);
    });

    this._els.colourMode.value = this._colourMode;
    this._els.colourMode.addEventListener("change", () => {
      this._colourMode = this._els.colourMode.value;
      this._renderLegend();
      this._draw();
    });

    Object.entries(PSY_DEFAULT_RANGES).forEach(([key, item]) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = item.label;
      this._els.range.append(option);
    });
    this._els.range.value = this._range;
    this._els.customStart.value = this._customStart;
    this._els.customEnd.value = this._customEnd;
    this._els.customRange.hidden = this._range !== "custom";
    this._els.range.addEventListener("change", () => {
      this._range = this._els.range.value;
      this._els.customRange.hidden = this._range !== "custom";
      this._data = null;
      this._loadKey = null;
      this._load(true);
    });
    // Changing either custom boundary immediately reloads the selected window.
    const customDateChanged = () => {
      this._customStart = this._els.customStart.value;
      this._customEnd = this._els.customEnd.value;
      if (this._range !== "custom") return;
      this._data = null;
      this._loadKey = null;
      this._load(true);
    };
    this._els.customStart.addEventListener("change", customDateChanged);
    this._els.customEnd.addEventListener("change", customDateChanged);
    this._els.axisMode.value = this._axisMode;
    const fixedControlsVisible = this._axisMode === "fixed";
    this._els.axisControls.classList.toggle("is-hidden", !fixedControlsVisible);
    this._els.axisControls.setAttribute("aria-hidden", String(!fixedControlsVisible));
    this._els.axisTemperatureMin.value = String(this._fixedBounds.temperatureMin);
    this._els.axisTemperatureMax.value = String(this._fixedBounds.temperatureMax);
    this._els.axisAbsoluteMin.value = String(this._fixedBounds.absoluteMin);
    this._els.axisAbsoluteMax.value = String(this._fixedBounds.absoluteMax);
    this._els.axisMode.addEventListener("change", () => {
      this._axisMode = this._els.axisMode.value;
      const showFixedControls = this._axisMode === "fixed";
      this._els.axisControls.classList.toggle("is-hidden", !showFixedControls);
      this._els.axisControls.setAttribute("aria-hidden", String(!showFixedControls));
      this._saveAxisPreferences();
      this._data = null;
      this._loadKey = null;
      this._load(true);
    });
    // All four fixed bounds are user-editable. Rebinning after a change keeps
    // the chart, heatmap and hover coordinates on the same explicit scale.
    const fixedAxisChanged = () => {
      this._fixedBounds = {
        temperatureMin: Number(this._els.axisTemperatureMin.value),
        temperatureMax: Number(this._els.axisTemperatureMax.value),
        absoluteMin: Number(this._els.axisAbsoluteMin.value),
        absoluteMax: Number(this._els.axisAbsoluteMax.value),
      };
      this._saveAxisPreferences();
      if (this._axisMode !== "fixed") return;
      this._data = null;
      this._loadKey = null;
      this._load(true);
    };
    [this._els.axisTemperatureMin, this._els.axisTemperatureMax,
      this._els.axisAbsoluteMin, this._els.axisAbsoluteMax]
      .forEach((input) => input.addEventListener("change", fixedAxisChanged));
    this._els.refresh.addEventListener("click", () => this._load(true));
    this._els.svg.addEventListener("pointermove", (event) => this._pointerMove(event));
    this._els.svg.addEventListener("pointerleave", () => { this._els.tooltip.style.display = "none"; });
    this._renderLegend();
    this._draw();
  }

  // Match the footer legend to the active colour mode and visible sensors.
  _renderLegend() {
    if (!this._els?.gradientLegend) return;
    if (this._colourMode === "original") {
      this._els.gradientLegend.innerHTML = `<span class="legend"><span>Less frequent</span><i class="ramp"></i><span>More frequent</span></span>`;
      return;
    }
    const selected = this._selectedSeries();
    this._els.gradientLegend.innerHTML = selected.length
      ? selected.map((item) => {
        const colour = this._sensorColour(item.index);
        return `<span class="sensor-ramp"><span>${psyEsc(item.name || `Sensor ${item.index + 1}`)}</span><i style="background:linear-gradient(90deg, color-mix(in srgb, ${colour} 12%, transparent), ${colour})"></i></span>`;
      }).join("")
      : `<span>No sensors selected</span>`;
  }

  /* -----------------------------------------------------------------------
   * Recorder data and histogram generation
   * -------------------------------------------------------------------- */

  // Resolve presets and custom dates into one recorder request window. Custom
  // dates use local midnight boundaries and include the complete end date.
  _resolveDateRange() {
    if (this._range !== "custom") {
      const preset = PSY_DEFAULT_RANGES[this._range];
      const end = new Date();
      let start;
      if (preset.months) {
        // Calendar-month subtraction preserves the day where possible and
        // clamps dates such as 31 March to the final day of February.
        start = new Date(end);
        const requestedDay = start.getDate();
        start.setDate(1);
        start.setMonth(start.getMonth() - preset.months);
        const lastTargetDay = new Date(
          start.getFullYear(), start.getMonth() + 1, 0,
        ).getDate();
        start.setDate(Math.min(requestedDay, lastTargetDay));
      } else {
        start = new Date(end.getTime() - preset.hours * 3600000);
      }
      return {
        start,
        end,
        period: preset.period,
        weight: preset.weight,
      };
    }
    if (!this._customStart || !this._customEnd) {
      throw new Error("Choose both a custom start date and end date.");
    }
    const start = new Date(`${this._customStart}T00:00:00`);
    const end = new Date(`${this._customEnd}T23:59:59.999`);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      throw new Error("The custom date range is invalid.");
    }
    if (start > end) throw new Error("The custom start date must not be after the end date.");
    const durationHours = (end.getTime() - start.getTime()) / 3600000;
    const useFiveMinuteBuckets = durationHours <= 24 * 7;
    return {
      start,
      end,
      period: useFiveMinuteBuckets ? "5minute" : "hour",
      weight: useFiveMinuteBuckets ? 1 / 12 : 1,
    };
  }

  // Return the original Lovelace limits. The dashboard's "Default scale"
  // option always uses these values, independently of saved custom limits.
  _originalBounds(validate = true) {
    const bounds = {
      temperatureMin: Number(this.config.min_temperature),
      temperatureMax: Number(this.config.max_temperature),
      absoluteMin: Number(this.config.min_absolute_humidity),
      absoluteMax: Number(this.config.max_absolute_humidity),
    };
    const finite = Object.values(bounds).every((value) => Number.isFinite(value));
    const ordered = bounds.temperatureMin < bounds.temperatureMax
      && bounds.absoluteMin < bounds.absoluteMax;
    if (validate && (!finite || !ordered)) {
      throw new Error("Default axis minimums must be numeric and lower than their maximums.");
    }
    return finite && ordered
      ? bounds
      : { temperatureMin: -10, temperatureMax: 40, absoluteMin: 0, absoluteMax: 25 };
  }

  // Validate the four manually configured limits. These values are retained
  // while the user temporarily switches to automatic or default scaling.
  _configuredBounds(validate = true) {
    const bounds = { ...this._fixedBounds };
    const finite = Object.values(bounds).every((value) => Number.isFinite(value));
    const ordered = bounds.temperatureMin < bounds.temperatureMax
      && bounds.absoluteMin < bounds.absoluteMax;
    if (validate && (!finite || !ordered)) {
      throw new Error("Fixed axis minimums must be numeric and lower than their maximums.");
    }
    return finite && ordered ? bounds : this._originalBounds(false);
  }

  // Automatic bounds are calculated from the actual selected recorder samples.
  // A small pad and rounded half-unit limits avoid data touching the frame.
  _axisBounds(samples) {
    // "Default" is an explicit reset to the original Lovelace bounds. It does
    // not discard the user's custom values, so returning to Fixed restores them.
    const fixed = this._axisMode === "default"
      ? this._originalBounds(true) : this._configuredBounds(true);
    const autoTemperature = ["auto_both", "auto_temperature"].includes(this._axisMode);
    const autoHumidity = ["auto_both", "auto_humidity"].includes(this._axisMode);
    if ((!autoTemperature && !autoHumidity) || !samples.length) return fixed;

    // Track extrema in one pass. This avoids spreading a year of hourly
    // samples into Math.min/Math.max, which can exceed a browser's argument
    // limit when several sensors are selected.
    let temperatureMinimum = Infinity;
    let temperatureMaximum = -Infinity;
    let absoluteMinimum = Infinity;
    let absoluteMaximum = -Infinity;
    samples.forEach((sample) => {
      const absolute = psyAbsoluteHumidity(sample.t, sample.rh / 100);
      if (Number.isFinite(sample.t) && Number.isFinite(absolute)) {
        temperatureMinimum = Math.min(temperatureMinimum, sample.t);
        temperatureMaximum = Math.max(temperatureMaximum, sample.t);
        absoluteMinimum = Math.min(absoluteMinimum, absolute);
        absoluteMaximum = Math.max(absoluteMaximum, absolute);
      }
    });
    if (!Number.isFinite(temperatureMinimum)) return fixed;

    const result = { ...fixed };
    if (autoTemperature) {
      const minimum = temperatureMinimum;
      const maximum = temperatureMaximum;
      const padding = Math.max(1, (maximum - minimum) * 0.06);
      result.temperatureMin = Math.floor((minimum - padding) * 2) / 2;
      result.temperatureMax = Math.ceil((maximum + padding) * 2) / 2;
      if (result.temperatureMax - result.temperatureMin < 5) {
        const centre = (result.temperatureMin + result.temperatureMax) / 2;
        result.temperatureMin = Math.floor((centre - 2.5) * 2) / 2;
        result.temperatureMax = Math.ceil((centre + 2.5) * 2) / 2;
      }
    }
    if (autoHumidity) {
      const minimum = absoluteMinimum;
      const maximum = absoluteMaximum;
      const padding = Math.max(0.5, (maximum - minimum) * 0.08);
      result.absoluteMin = Math.max(0, Math.floor((minimum - padding) * 2) / 2);
      result.absoluteMax = Math.ceil((maximum + padding) * 2) / 2;
      if (result.absoluteMax - result.absoluteMin < 3) {
        const centre = (result.absoluteMin + result.absoluteMax) / 2;
        result.absoluteMin = Math.max(0, Math.floor((centre - 1.5) * 2) / 2);
        result.absoluteMax = Math.ceil((centre + 1.5) * 2) / 2;
      }
    }
    return result;
  }

  async _load(force = false) {
    if (!this._hass || this._loading) return;
    const selected = this._selectedSeries();
    let dateRange;
    try {
      dateRange = this._resolveDateRange();
    } catch (error) {
      this._data = this._bin([], this._configuredBounds(false));
      this._error = error.message;
      this._renderStatus();
      this._draw();
      return;
    }
    const rangeKey = this._range === "custom"
      ? `${this._customStart}|${this._customEnd}` : this._range;
    // Scaling is part of the cache identity so a restored browser preference
    // cannot accidentally reuse bins produced for a different set of bounds.
    const axisKey = `${this._axisMode}|${Object.values(this._fixedBounds).join(",")}`;
    const key = `${selected.map((item) => item.index).join(",")}|${rangeKey}|${axisKey}`;
    if (!force && this._loadKey === key && this._data) return;

    // An empty selection is valid and intentionally produces an empty chart.
    if (!selected.length) {
      try {
        this._data = this._bin([], this._axisBounds([]));
        this._error = null;
      } catch (error) {
        this._data = this._bin([], this._configuredBounds(false));
        this._error = error && error.message ? error.message : String(error);
      }
      this._loadKey = key;
      this._renderStatus();
      this._draw();
      return;
    }

    this._loading = true;
    this._error = null;
    this._renderStatus();
    try {
      const statisticIds = [...new Set(selected.flatMap((item) => [item.temperature, item.humidity]))];
      const response = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: dateRange.start.toISOString(),
        end_time: dateRange.end.toISOString(),
        statistic_ids: statisticIds,
        period: dateRange.period,
        types: ["mean"],
      });

      // Pair temperature and RH only when their recorder bucket timestamps match.
      const samples = [];
      for (const pair of selected) {
        const temperatures = (response && response[pair.temperature]) || [];
        const humidities = (response && response[pair.humidity]) || [];
        const humidityByStart = new Map(humidities
          .filter((point) => typeof point.start === "number" && Number.isFinite(point.mean))
          .map((point) => [point.start, point.mean]));
        temperatures
          .filter((point) => typeof point.start === "number"
            && Number.isFinite(point.mean) && humidityByStart.has(point.start))
          .forEach((point) => samples.push({
            t: point.mean,
            rh: humidityByStart.get(point.start),
            hours: dateRange.weight,
            seriesIndex: pair.index,
          }));
      }

      const bounds = this._axisBounds(samples);
      this._data = this._bin(samples, bounds);
      this._data.from = dateRange.start;
      this._data.to = dateRange.end;
      this._loadKey = key;
      if (!samples.length) this._error = "No paired recorder statistics were returned for the selected sensors and period.";
    } catch (error) {
      this._data = this._bin([], this._configuredBounds(false));
      this._error = error && error.message ? error.message : String(error);
    } finally {
      this._loading = false;
      this._renderStatus();
      this._draw();
    }
  }

  // Convert each sample to absolute humidity and accumulate it into a fine bin.
  _bin(samples, bounds) {
    const temperatureStep = Number(this.config.temperature_bin) || 0.5;
    const absoluteStep = Number(this.config.absolute_humidity_bin) || 0.25;
    const { temperatureMin, temperatureMax, absoluteMin, absoluteMax } = bounds;
    const bins = new Map();
    let totalHours = 0;
    let accepted = 0;

    for (const sample of samples) {
      const absolute = psyAbsoluteHumidity(sample.t, sample.rh / 100);
      if (!Number.isFinite(absolute) || sample.t < temperatureMin || sample.t >= temperatureMax
        || absolute < absoluteMin || absolute >= absoluteMax) continue;
      const temperatureIndex = Math.floor((sample.t - temperatureMin) / temperatureStep);
      const absoluteIndex = Math.floor((absolute - absoluteMin) / absoluteStep);
      const key = `${temperatureIndex},${absoluteIndex}`;
      const current = bins.get(key) || {
        temperatureIndex, absoluteIndex, hours: 0, samples: 0,
        series: new Set(), hoursBySeries: new Map(),
      };
      current.hours += sample.hours;
      current.samples += 1;
      current.series.add(sample.seriesIndex);
      current.hoursBySeries.set(
        sample.seriesIndex,
        (current.hoursBySeries.get(sample.seriesIndex) || 0) + sample.hours,
      );
      bins.set(key, current);
      totalHours += sample.hours;
      accepted += 1;
    }

    const values = [...bins.values()];
    const maxHoursBySeries = new Map();
    values.forEach((bin) => bin.hoursBySeries.forEach((hours, seriesIndex) => {
      maxHoursBySeries.set(seriesIndex,
        Math.max(maxHoursBySeries.get(seriesIndex) || 0, hours));
    }));
    return {
      bins: values,
      maxHours: values.reduce((maximum, bin) => Math.max(maximum, bin.hours), 0),
      totalHours,
      samples: accepted,
      temperatureStep,
      absoluteStep,
      maxHoursBySeries,
      bounds,
    };
  }

  // Calculate live markers for every selected pair without querying recorder.
  _updateLive() {
    if (!this._hass || !this._els) return;
    const pressure = this._pressure();
    this._live = this._selectedSeries().map((pair) => {
      const temperature = Number(this._hass.states[pair.temperature]?.state);
      const relativeHumidity = Number(this._hass.states[pair.humidity]?.state);
      if (!Number.isFinite(temperature) || !Number.isFinite(relativeHumidity)) return null;
      return {
        index: pair.index,
        name: pair.name || `Air source ${pair.index + 1}`,
        temperature,
        relativeHumidity,
        absolute: psyAbsoluteHumidity(temperature, relativeHumidity / 100),
        ratio: psyHumidityRatio(temperature, relativeHumidity / 100, pressure),
      };
    }).filter(Boolean);

    if (!this._live.length) this._els.live.textContent = "Live: no selected sensor data";
    else if (this._live.length === 1) {
      const point = this._live[0];
      this._els.live.textContent = `Live ${point.name}: ${point.temperature.toFixed(1)} °C · ${point.relativeHumidity.toFixed(0)}% RH · ${point.absolute.toFixed(1)} g/m³`;
    } else this._els.live.textContent = `Live markers: ${this._live.length} selected sensors`;
    this._draw();
  }

  _renderStatus() {
    if (!this._els) return;
    if (this._loading) {
      this._els.summary.className = "summary";
      this._els.summary.textContent = "Loading recorder statistics…";
      return;
    }
    if (this._error) {
      this._els.summary.className = "summary error";
      this._els.summary.textContent = this._error;
      return;
    }
    const hours = this._data ? this._data.totalHours : 0;
    const selectedCount = this._selectedIndexes.size;
    const bounds = this._data?.bounds;
    const scaleText = bounds
      ? ` · T ${bounds.temperatureMin}–${bounds.temperatureMax} °C · AH ${bounds.absoluteMin}–${bounds.absoluteMax} g/m³`
      : "";
    this._els.summary.className = `summary${hours ? "" : " empty"}`;
    this._els.summary.textContent = hours
      ? `${hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} sensor-hours · ${this._data.bins.length} occupied bins · ${selectedCount} selected${scaleText}`
      : `${selectedCount} sensors selected${scaleText}`;
  }

  // Shared multi-stop ramp: toggling sensors never changes the colour semantics.
  _colour(value, maximum) {
    const normalised = maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0;
    const stops = [
      [0, [32, 146, 255]], [0.28, [22, 165, 255]], [0.52, [93, 67, 255]],
      [0.76, [197, 43, 218]], [1, [255, 106, 26]],
    ];
    let lower = stops[0];
    let upper = stops[stops.length - 1];
    for (let index = 1; index < stops.length; index += 1) {
      if (normalised <= stops[index][0]) {
        lower = stops[index - 1]; upper = stops[index]; break;
      }
    }
    const fraction = (normalised - lower[0]) / Math.max(0.001, upper[0] - lower[0]);
    const rgb = lower[1].map((component, index) => Math.round(
      component + (upper[1][index] - component) * fraction,
    ));
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.18 + 0.78 * Math.pow(normalised, 0.55)})`;
  }

  // A per-sensor gradient changes only opacity: hue remains stable while high
  // frequency becomes bright/intense and low frequency remains pale/faded.
  _singleHueColour(hex, value, maximum) {
    const normalised = maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0;
    const red = parseInt(hex.slice(1, 3), 16);
    const green = parseInt(hex.slice(3, 5), 16);
    const blue = parseInt(hex.slice(5, 7), 16);
    return `rgba(${red},${green},${blue},${0.13 + 0.87 * Math.pow(normalised, 0.55)})`;
  }

  /* -----------------------------------------------------------------------
   * SVG chart drawing
   * -------------------------------------------------------------------- */

  _geometry() {
    if (!this._els) return null;
    const width = Math.max(320, this._els.wrap.clientWidth || 900);
    const height = Math.max(width < 600 ? 390 : 440, Math.min(690, width * 0.58));
    const margin = width < 600
      ? { left: 20, right: 92, top: 48, bottom: 50 }
      : { left: 34, right: 124, top: 48, bottom: 56 };
    const plot = {
      x: margin.left,
      y: margin.top,
      width: width - margin.left - margin.right,
      height: height - margin.top - margin.bottom,
    };
    const bounds = this._data?.bounds || this._configuredBounds(false);
    const { temperatureMin, temperatureMax, absoluteMin, absoluteMax } = bounds;
    return {
      width, height, plot, temperatureMin, temperatureMax, absoluteMin, absoluteMax,
      x: (temperature) => plot.x + ((temperature - temperatureMin)
        / (temperatureMax - temperatureMin)) * plot.width,
      y: (absolute) => plot.y + plot.height - ((absolute - absoluteMin)
        / (absoluteMax - absoluteMin)) * plot.height,
      inverseX: (x) => temperatureMin + ((x - plot.x) / plot.width)
        * (temperatureMax - temperatureMin),
      inverseY: (y) => absoluteMin + ((plot.y + plot.height - y) / plot.height)
        * (absoluteMax - absoluteMin),
    };
  }

  // Generate an SVG path for one relative-humidity curve in AH coordinates.
  _pathForRh(relativeHumidity, geometry) {
    const parts = [];
    for (let temperature = geometry.temperatureMin;
      temperature <= geometry.temperatureMax + 0.001; temperature += 0.2) {
      const absolute = psyAbsoluteHumidity(temperature, relativeHumidity / 100);
      if (absolute < geometry.absoluteMin || absolute > geometry.absoluteMax) continue;
      parts.push(`${parts.length ? "L" : "M"}${geometry.x(temperature).toFixed(1)},${geometry.y(absolute).toFixed(1)}`);
    }
    return parts.join(" ");
  }

  _draw() {
    if (!this._els || !this.config) return;
    const geometry = this._geometry();
    if (!geometry) return;
    this._geom = geometry;
    const { plot } = geometry;
    const textColour = "var(--secondary-text-color)";
    const gridColour = "var(--divider-color)";
    const primaryColour = "var(--primary-text-color)";
    const pressure = this._pressure();
    const altitude = Number(this.config.altitude) || 0;
    const ratioReference = Number(this.config.humidity_ratio_reference_temperature) || 20;
    const svg = [];
    const relativeHumidityLabels = [];

    svg.push(`<svg viewBox="0 0 ${geometry.width} ${geometry.height}" preserveAspectRatio="none">`);
    svg.push(`<defs><clipPath id="psy-clip"><rect x="${plot.x}" y="${plot.y}" width="${plot.width}" height="${plot.height}"/></clipPath></defs>`);
    svg.push(`<rect x="${plot.x}" y="${plot.y}" width="${plot.width}" height="${plot.height}" fill="var(--card-background-color)" stroke="${gridColour}"/>`);

    // Minor temperature grid every 1 °C; major labels every 5 °C (10 °C mobile).
    const temperatureLabelStep = geometry.width < 600 ? 10 : 5;
    for (let temperature = Math.ceil(geometry.temperatureMin);
      temperature <= geometry.temperatureMax; temperature += 1) {
      const x = geometry.x(temperature);
      const major = temperature % temperatureLabelStep === 0;
      svg.push(`<line x1="${x}" y1="${plot.y}" x2="${x}" y2="${plot.y + plot.height}" stroke="${gridColour}" stroke-width="${major ? 1 : 0.55}" stroke-opacity="${major ? 1 : 0.55}"/>`);
      if (major) svg.push(`<text x="${x}" y="${plot.y + plot.height + 20}" text-anchor="middle" fill="${textColour}" font-size="11">${temperature}</text>`);
    }

    // Both moisture scales are on the right: absolute humidity is the first
    // (primary) column, and humidity ratio is the second column farther right.
    for (let absolute = Math.ceil(geometry.absoluteMin);
      absolute <= geometry.absoluteMax + 0.001; absolute += 1) {
      const y = geometry.y(absolute);
      const major = absolute % 2 === 0;
      svg.push(`<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.width}" y2="${y}" stroke="${gridColour}" stroke-width="${major ? 1 : 0.55}" stroke-opacity="${major ? 1 : 0.55}"/>`);
      if (major) {
        const ratio = psyRatioFromAbsolute(ratioReference, absolute, pressure);
        svg.push(`<text x="${plot.x + plot.width + 8}" y="${y + 4}" fill="${primaryColour}" font-size="10">${absolute.toFixed(0)}</text>`);
        svg.push(`<text x="${plot.x + plot.width + 48}" y="${y + 4}" fill="${textColour}" font-size="10">${ratio.toFixed(1)}</text>`);
      }
    }

    svg.push(`<g clip-path="url(#psy-clip)">`);
    // RH curves are reference geometry behind the frequency cells.
    for (let relativeHumidity = 10; relativeHumidity <= 100; relativeHumidity += 10) {
      const saturation = relativeHumidity === 100;
      svg.push(`<path d="${this._pathForRh(relativeHumidity, geometry)}" fill="none" stroke="${saturation ? primaryColour : textColour}" stroke-opacity="${saturation ? 0.8 : 0.58}" stroke-width="${saturation ? 1.8 : 1}" stroke-dasharray="${saturation ? "none" : "4 4"}"/>`);
      const absoluteAtRight = psyAbsoluteHumidity(
        geometry.temperatureMax, relativeHumidity / 100,
      );
      if (absoluteAtRight >= geometry.absoluteMax) {
        // Find where the curve crosses the top boundary with a binary search.
        let lower = geometry.temperatureMin;
        let upper = geometry.temperatureMax;
        for (let iteration = 0; iteration < 32; iteration += 1) {
          const midpoint = (lower + upper) / 2;
          if (psyAbsoluteHumidity(midpoint, relativeHumidity / 100)
            < geometry.absoluteMax) lower = midpoint;
          else upper = midpoint;
        }
        const x = geometry.x((lower + upper) / 2);
        const label = saturation ? "Relative Humidity 100%" : `${relativeHumidity}%`;
        relativeHumidityLabels.push(`<text x="${x}" y="${plot.y - 7}" text-anchor="${saturation ? "end" : "middle"}" fill="${textColour}" font-size="10">${label}</text>`);
      } else if (absoluteAtRight >= geometry.absoluteMin) {
        // Curves that do not reach the top are labelled at the right boundary.
        relativeHumidityLabels.push(`<text x="${plot.x + plot.width - 6}" y="${geometry.y(absoluteAtRight) - 4}" text-anchor="end" fill="${textColour}" font-size="10">${relativeHumidity}%</text>`);
      }
    }

    // Original mode draws one aggregate cell with the familiar multi-colour
    // ramp. Sensor mode divides a cell into equal-width strips so overlapping
    // sensors remain identifiable, with intensity normalised per sensor.
    if (this._data) {
      for (const bin of this._data.bins) {
        const temperature0 = geometry.temperatureMin
          + bin.temperatureIndex * this._data.temperatureStep;
        const absolute0 = this._data.bounds.absoluteMin
          + bin.absoluteIndex * this._data.absoluteStep;
        const x0 = geometry.x(temperature0);
        const x1 = geometry.x(temperature0 + this._data.temperatureStep);
        const y0 = geometry.y(absolute0 + this._data.absoluteStep);
        const y1 = geometry.y(absolute0);
        const centreTemperature = temperature0 + this._data.temperatureStep / 2;
        const centreAbsolute = absolute0 + this._data.absoluteStep / 2;
        if (centreAbsolute > psyAbsoluteHumidity(centreTemperature, 1)
          + this._data.absoluteStep / 2) continue;
        if (this._colourMode === "original") {
          svg.push(`<rect x="${(x0 + 0.35).toFixed(1)}" y="${(y0 + 0.35).toFixed(1)}" width="${Math.max(0.4, x1 - x0 - 0.7).toFixed(1)}" height="${Math.max(0.4, y1 - y0 - 0.7).toFixed(1)}" rx="0.7" fill="${this._colour(bin.hours, this._data.maxHours)}"/>`);
        } else {
          const contributors = this._selectedSeries()
            .filter((item) => (bin.hoursBySeries.get(item.index) || 0) > 0);
          const availableWidth = Math.max(0.4, x1 - x0 - 0.7);
          const stripWidth = availableWidth / Math.max(1, contributors.length);
          contributors.forEach((item, stripIndex) => {
            const hours = bin.hoursBySeries.get(item.index) || 0;
            const maximum = this._data.maxHoursBySeries.get(item.index) || 0;
            svg.push(`<rect x="${(x0 + 0.35 + stripIndex * stripWidth).toFixed(1)}" y="${(y0 + 0.35).toFixed(1)}" width="${Math.max(0.25, stripWidth - 0.15).toFixed(1)}" height="${Math.max(0.4, y1 - y0 - 0.7).toFixed(1)}" rx="0.5" fill="${this._singleHueColour(this._sensorColour(item.index), hours, maximum)}"/>`);
          });
        }
      }
    }

    // Live points are pink rings; numbered labels correspond to checkbox order.
    for (const point of this._live || []) {
      if (point.temperature < geometry.temperatureMin || point.temperature > geometry.temperatureMax
        || point.absolute < geometry.absoluteMin || point.absolute > geometry.absoluteMax) continue;
      const x = geometry.x(point.temperature);
      const y = geometry.y(point.absolute);
      svg.push(`<circle cx="${x}" cy="${y}" r="7" fill="#ff3d8d" fill-opacity=".25" stroke="#ff3d8d" stroke-width="2"/>`);
      svg.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="#ff3d8d"/>`);
      if ((this._live || []).length > 1) svg.push(`<text x="${x + 8}" y="${y - 7}" fill="#ff3d8d" font-size="9" font-weight="600">${point.index + 1}</text>`);
    }
    svg.push(`</g>`);
    svg.push(...relativeHumidityLabels);

    // Axis titles and calculation assumptions are always visible above the plot.
    svg.push(`<text x="${plot.x + plot.width / 2}" y="${geometry.height - 10}" text-anchor="middle" fill="${primaryColour}" font-size="12">Dry-bulb temperature (°C)</text>`);
    svg.push(`<text x="${plot.x + plot.width + 8}" y="${plot.y - 34}" fill="${primaryColour}" font-size="9">Absolute</text>`);
    svg.push(`<text x="${plot.x + plot.width + 8}" y="${plot.y - 23}" fill="${primaryColour}" font-size="9">humidity</text>`);
    svg.push(`<text x="${plot.x + plot.width + 8}" y="${plot.y - 12}" fill="${primaryColour}" font-size="9">(g/m³)</text>`);
    svg.push(`<text x="${plot.x + plot.width + 48}" y="${plot.y - 38}" fill="${textColour}" font-size="9">Equivalent</text>`);
    svg.push(`<text x="${plot.x + plot.width + 48}" y="${plot.y - 27}" fill="${textColour}" font-size="9">humidity ratio</text>`);
    svg.push(`<text x="${plot.x + plot.width + 48}" y="${plot.y - 16}" fill="${textColour}" font-size="9">at ${ratioReference.toFixed(0)} °C ref. (g/kg)</text>`);
    svg.push(`<text x="${plot.x + 6}" y="${plot.y + 15}" fill="${textColour}" font-size="10">Assumed pressure ${pressure.toFixed(3)} kPa · altitude ${altitude.toFixed(0)} m</text>`);
    if (this._data && !this._data.samples && !this._loading) {
      svg.push(`<text x="${plot.x + plot.width / 2}" y="${plot.y + plot.height / 2}" text-anchor="middle" fill="${textColour}" font-size="14">No paired statistics for the selected sensors</text>`);
    }
    svg.push(`</svg>`);
    this._els.svg.innerHTML = svg.join("");
    this._els.svg.setAttribute("viewBox", `0 0 ${geometry.width} ${geometry.height}`);
    this._els.svg.style.height = `${geometry.height}px`;
  }

  /* Show the frequency and both moisture quantities for the hovered bin. */
  _pointerMove(event) {
    if (!this._data || !this._data.bins.length || !this._geom) return;
    const rectangle = this._els.svg.getBoundingClientRect();
    const chartX = ((event.clientX - rectangle.left) / rectangle.width) * this._geom.width;
    const chartY = ((event.clientY - rectangle.top) / rectangle.height) * this._geom.height;
    const temperature = this._geom.inverseX(chartX);
    const absolute = this._geom.inverseY(chartY);
    const temperatureIndex = Math.floor((temperature - this._geom.temperatureMin)
      / this._data.temperatureStep);
    const absoluteIndex = Math.floor((absolute - this._data.bounds.absoluteMin)
      / this._data.absoluteStep);
    const bin = this._data.bins.find((item) => item.temperatureIndex === temperatureIndex
      && item.absoluteIndex === absoluteIndex);
    if (!bin) { this._els.tooltip.style.display = "none"; return; }

    const temperature0 = this._geom.temperatureMin
      + temperatureIndex * this._data.temperatureStep;
    const absolute0 = this._data.bounds.absoluteMin
      + absoluteIndex * this._data.absoluteStep;
    const centreTemperature = temperature0 + this._data.temperatureStep / 2;
    const centreAbsolute = absolute0 + this._data.absoluteStep / 2;
    const share = this._data.totalHours ? 100 * bin.hours / this._data.totalHours : 0;
    const relativeHumidity = psyRhFromAbsolute(centreTemperature, centreAbsolute);
    const ratio = psyRatioFromAbsolute(centreTemperature, centreAbsolute, this._pressure());
    const sensorBreakdown = this._colourMode === "sensor"
      ? this._selectedSeries()
        .filter((item) => bin.hoursBySeries.has(item.index))
        .map((item) => `${psyEsc(item.name || `Sensor ${item.index + 1}`)}: ${bin.hoursBySeries.get(item.index).toFixed(1)} h`)
        .join("<br>")
      : "";
    this._els.tooltip.innerHTML = `<strong>${bin.hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} sensor-hours</strong><br>${share.toFixed(1)}% of selected data<br>${temperature0.toFixed(1)}–${(temperature0 + this._data.temperatureStep).toFixed(1)} °C<br>${absolute0.toFixed(2)}–${(absolute0 + this._data.absoluteStep).toFixed(2)} g/m³<br>≈ ${ratio.toFixed(2)} g/kg · ${relativeHumidity.toFixed(0)}% RH<br>${bin.series.size} sensor${bin.series.size === 1 ? "" : "s"} contributed${sensorBreakdown ? `<br>${sensorBreakdown}` : ""}`;
    this._els.tooltip.style.display = "block";
    this._els.tooltip.style.left = `${Math.min(rectangle.width - 260, Math.max(8, event.clientX - rectangle.left + 14))}px`;
    this._els.tooltip.style.top = `${Math.max(8, event.clientY - rectangle.top - 120)}px`;
  }
}

/* Minimal editor guidance keeps the card usable in HA's visual editor while
 * retaining YAML as the portable, GitHub-friendly source of truth. */
class PsychrometricChartCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; }
  set hass(hass) { this._hass = hass; this._render(); }
  _render() {
    if (!this._config || this._rendered) return;
    this._rendered = true;
    this.innerHTML = `<div style="padding:16px;color:var(--secondary-text-color)">Configure this card in YAML. Each <code>series</code> entry requires a <code>temperature</code> and <code>humidity</code> entity; use <code>default_visible: true</code> for initial overlays.</div>`;
  }
}

if (!customElements.get(PSY_CARD)) customElements.define(PSY_CARD, PsychrometricChartCard);
if (!customElements.get("psychrometric-chart-card-editor")) {
  customElements.define("psychrometric-chart-card-editor", PsychrometricChartCardEditor);
}

// Register metadata so the card appears in Home Assistant's card picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: PSY_CARD,
  name: "Psychrometric Frequency Chart",
  description: "Interactive multi-sensor absolute-humidity frequency heatmap",
  preview: true,
});


