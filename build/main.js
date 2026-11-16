"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_axios = __toESM(require("axios"));
const API_URL = "https://api.tronity.tech";
const REQUEST_TIMEOUT_MS = 3e4;
const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 30;
const TOKEN_EXPIRY_MARGIN_MS = 12e4;
const STATES = [
  {
    id: "command.Charging",
    name: { en: "Start/stop charging", de: "Laden starten/stoppen" },
    type: "boolean",
    role: "switch",
    write: true
  },
  {
    id: "odometer",
    name: { en: "Odometer", de: "Kilometerstand" },
    type: "number",
    role: "value.distance",
    unit: "km"
  },
  { id: "range", name: { en: "Range", de: "Reichweite" }, type: "number", role: "value.distance", unit: "km" },
  { id: "level", name: { en: "Battery level", de: "Akkustand" }, type: "number", role: "value.battery", unit: "%" },
  { id: "charging", name: { en: "Charging status", de: "Ladestatus" }, type: "string", role: "text" },
  {
    id: "chargeRemainingTime",
    name: { en: "Remaining charging time", de: "Restladezeit" },
    type: "number",
    role: "value"
  },
  { id: "plugged", name: { en: "Plugged in", de: "Ladekabel eingesteckt" }, type: "boolean", role: "indicator" },
  {
    id: "chargerPower",
    name: { en: "Charging power", de: "Ladeleistung" },
    type: "number",
    role: "value.power",
    unit: "kW"
  },
  {
    id: "latitude",
    name: { en: "Latitude", de: "Breitengrad" },
    type: "number",
    role: "value.gps.latitude",
    unit: "\xB0"
  },
  {
    id: "longitude",
    name: { en: "Longitude", de: "L\xE4ngengrad" },
    type: "number",
    role: "value.gps.longitude",
    unit: "\xB0"
  },
  {
    id: "outTemp",
    name: { en: "Outside temperature", de: "Au\xDFentemperatur" },
    type: "number",
    role: "value.temperature",
    unit: "\xB0C",
    optional: true
  },
  {
    id: "elevation",
    name: { en: "Elevation", de: "H\xF6he" },
    type: "number",
    role: "value.gps.elevation",
    unit: "m",
    optional: true
  },
  {
    id: "timestamp",
    name: { en: "Time of the record", de: "Zeitpunkt des Datensatzes" },
    type: "number",
    role: "value.time"
  },
  { id: "lastUpdate", name: { en: "Last update", de: "Letzte Aktualisierung" }, type: "number", role: "value.time" }
];
const OBSOLETE_STATES = ["power"];
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function toEpochMs(value) {
  if (isNumber(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
function formatError(e) {
  var _a, _b, _c;
  if (e == null ? void 0 : e.response) {
    return `HTTP ${e.response.status} on ${(_b = (_a = e.config) == null ? void 0 : _a.url) != null ? _b : "unknown URL"}: ${JSON.stringify(e.response.data)}`;
  }
  return (_c = e == null ? void 0 : e.message) != null ? _c : String(e);
}
function isUnauthorized(e) {
  var _a;
  return ((_a = e == null ? void 0 : e.response) == null ? void 0 : _a.status) === 401;
}
class Tronity extends utils.Adapter {
  pollTimer = void 0;
  unloading = false;
  token = void 0;
  createdOptionalStates = /* @__PURE__ */ new Set();
  constructor(options = {}) {
    super({
      ...options,
      name: "tronity"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    try {
      await this.setConnected(false);
      const missing = ["client_id", "client_secret", "vehicle_id"].filter((key) => !this.config[key]);
      if (missing.length > 0) {
        this.log.warn(
          `Adapter is not configured completely (missing: ${missing.join(", ")}). Please enter client ID and secret, then select a vehicle in the instance settings.`
        );
        return;
      }
      await this.extendObjectAsync("command", {
        type: "channel",
        common: { name: { en: "Commands", de: "Befehle" } },
        native: {}
      });
      for (const def of STATES) {
        if (def.optional) {
          await this.initOptionalState(def);
        } else {
          await this.createStateObject(def);
        }
      }
      for (const id of OBSOLETE_STATES) {
        if (await this.getObjectAsync(id)) {
          await this.delObjectAsync(id);
        }
      }
      this.subscribeStates("command.*");
      await this.poll();
    } catch (e) {
      this.log.error(`Error during startup: ${formatError(e)}`);
    }
  }
  async createStateObject(def) {
    var _a;
    await this.extendObjectAsync(def.id, {
      type: "state",
      common: {
        name: def.name,
        type: def.type,
        role: def.role,
        read: true,
        write: (_a = def.write) != null ? _a : false,
        ...def.unit ? { unit: def.unit } : {}
      },
      native: {}
    });
  }
  /**
   * Keeps an optional state that already has a value, removes it if it never received one.
   *
   * @param def definition of the optional state
   */
  async initOptionalState(def) {
    if (!await this.getObjectAsync(def.id)) {
      return;
    }
    const state = await this.getStateAsync(def.id);
    if ((state == null ? void 0 : state.val) === null || (state == null ? void 0 : state.val) === void 0) {
      await this.delObjectAsync(def.id);
      return;
    }
    await this.createStateObject(def);
    this.createdOptionalStates.add(def.id);
  }
  /**
   * Writes an optional state and creates its object on first use.
   *
   * @param id state ID
   * @param value value delivered by the API
   */
  async setOptionalState(id, value) {
    const def = STATES.find((d) => d.id === id);
    if (def && !this.createdOptionalStates.has(id)) {
      await this.createStateObject(def);
      this.createdOptionalStates.add(id);
    }
    await this.setState(id, value, true);
  }
  getIntervalMs() {
    const configured = Number(this.config.interval);
    const seconds = isNumber(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_S;
    return Math.max(seconds, MIN_INTERVAL_S) * 1e3;
  }
  async setConnected(connected) {
    await this.setStateChangedAsync("info.connection", connected, true);
  }
  async requestToken(client_id, client_secret) {
    const response = await import_axios.default.post(
      `${API_URL}/authentication`,
      { client_id, client_secret, grant_type: "app" },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    return response.data;
  }
  async getToken() {
    if (this.token && this.token.expiresAt > Date.now()) {
      return this.token.value;
    }
    const token = await this.requestToken(this.config.client_id, this.config.client_secret);
    const lifetimeMs = isNumber(token.expires_in) ? token.expires_in * 1e3 : 0;
    this.token = {
      value: token.access_token,
      expiresAt: Date.now() + Math.max(lifetimeMs - TOKEN_EXPIRY_MARGIN_MS, 0)
    };
    return token.access_token;
  }
  /**
   * Runs an authenticated request; on HTTP 401 the token is renewed once and the request repeated.
   *
   * @param request performs the API call with the given access token
   */
  async withToken(request) {
    try {
      return await request(await this.getToken());
    } catch (e) {
      if (!isUnauthorized(e)) {
        throw e;
      }
      this.token = void 0;
      return request(await this.getToken());
    }
  }
  async poll() {
    try {
      await this.updateVehicleData();
      await this.setConnected(true);
    } catch (e) {
      this.log.error(`Could not update vehicle data: ${formatError(e)}`);
      await this.setConnected(false).catch(() => void 0);
    }
    if (!this.unloading) {
      this.pollTimer = this.setTimeout(() => {
        void this.poll();
      }, this.getIntervalMs());
    }
  }
  async updateVehicleData() {
    const url = `${API_URL}/tronity/vehicles/${this.config.vehicle_id}/last_record`;
    const status = await this.withToken(async (token) => {
      const response = await import_axios.default.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT_MS
      });
      return response.data;
    });
    this.log.debug(`last_record: ${JSON.stringify(status)}`);
    if (isNumber(status.odometer) && status.odometer >= 0) {
      await this.setState("odometer", status.odometer, true);
    }
    if (isNumber(status.range) && status.range >= 0) {
      await this.setState("range", status.range, true);
    }
    if (isNumber(status.level) && status.level >= 0) {
      await this.setState("level", status.level, true);
    }
    if (typeof status.charging === "string" && status.charging.length > 0) {
      await this.setState("charging", status.charging, true);
    }
    if (typeof status.plugged === "boolean") {
      await this.setState("plugged", status.plugged, true);
    }
    const disconnected = status.charging === "Disconnected" || status.plugged === false;
    if (disconnected) {
      await this.setState("chargerPower", 0, true);
      await this.setState("chargeRemainingTime", 0, true);
    } else {
      if (isNumber(status.chargerPower) && status.chargerPower >= 0) {
        await this.setState("chargerPower", status.chargerPower, true);
      }
      if (isNumber(status.chargeRemainingTime) && status.chargeRemainingTime >= 0) {
        await this.setState("chargeRemainingTime", status.chargeRemainingTime, true);
      }
    }
    if (isNumber(status.latitude)) {
      await this.setState("latitude", status.latitude, true);
    }
    if (isNumber(status.longitude)) {
      await this.setState("longitude", status.longitude, true);
    }
    if (isNumber(status.outTemp) && status.outTemp > -100) {
      await this.setOptionalState("outTemp", status.outTemp);
    }
    if (isNumber(status.elevation) && status.elevation > -100) {
      await this.setOptionalState("elevation", status.elevation);
    }
    const timestamp = toEpochMs(status.timestamp);
    if (timestamp !== null) {
      await this.setState("timestamp", timestamp, true);
    }
    const lastUpdate = toEpochMs(status.lastUpdate);
    if (lastUpdate !== null) {
      await this.setState("lastUpdate", lastUpdate, true);
    }
  }
  async fetchVehicles(client_id, client_secret) {
    var _a;
    const token = await this.requestToken(client_id, client_secret);
    const response = await import_axios.default.get(`${API_URL}/tronity/vehicles?limit=1000`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      timeout: REQUEST_TIMEOUT_MS
    });
    return (_a = response.data.data) != null ? _a : [];
  }
  async onMessage(msg) {
    var _a;
    if (msg.command !== "validate" && msg.command !== "testConnection") {
      return;
    }
    const message = (_a = msg.message) != null ? _a : {};
    const client_id = message.client_id || this.config.client_id;
    const client_secret = message.client_secret || this.config.client_secret;
    if (msg.command === "testConnection") {
      await this.testConnection(msg, client_id, client_secret);
      return;
    }
    if (!client_id || !client_secret) {
      this.sendTo(msg.from, msg.command, [], msg.callback);
      return;
    }
    this.log.info("Try to validate login data and get vehicles");
    try {
      const vehicles = await this.fetchVehicles(client_id, client_secret);
      const options = vehicles.map((v) => ({
        label: `${v.manufacture} ${v.displayName}`,
        value: v.id
      }));
      this.sendTo(msg.from, msg.command, options, msg.callback);
    } catch (e) {
      this.log.error(`Could not validate login data: ${formatError(e)}`);
      this.sendTo(msg.from, msg.command, [], msg.callback);
    }
  }
  /**
   * Answers the "Check Login Data" button: `{result, args}` on success, `{error}` otherwise.
   *
   * @param msg message from the admin UI
   * @param client_id client ID entered in the form
   * @param client_secret client secret entered in the form
   */
  async testConnection(msg, client_id, client_secret) {
    var _a;
    if (!client_id || !client_secret) {
      this.sendTo(
        msg.from,
        msg.command,
        { error: "Please enter client ID and client secret first." },
        msg.callback
      );
      return;
    }
    try {
      const vehicles = await this.fetchVehicles(client_id, client_secret);
      this.log.info(`Login data valid, ${vehicles.length} vehicle(s) found`);
      this.sendTo(msg.from, msg.command, { result: "ok", args: [String(vehicles.length)] }, msg.callback);
    } catch (e) {
      this.log.warn(`Login data check failed: ${formatError(e)}`);
      const error = isUnauthorized(e) ? "Login failed. Please check client ID and client secret." : `Connection to TRONITY failed: ${(e == null ? void 0 : e.response) ? `HTTP ${e.response.status}` : (_a = e == null ? void 0 : e.message) != null ? _a : String(e)}`;
      this.sendTo(msg.from, msg.command, { error }, msg.callback);
    }
  }
  onUnload(callback) {
    try {
      this.unloading = true;
      if (this.pollTimer) {
        this.clearTimeout(this.pollTimer);
        this.pollTimer = void 0;
      }
    } finally {
      callback();
    }
  }
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    this.log.debug(`State Change: ${id} to ${state.val} ack ${state.ack}`);
    const localId = id.substring(this.namespace.length + 1);
    if (localId !== "command.Charging" || !this.config.vehicle_id) {
      return;
    }
    const start = !!state.val;
    const action = start ? "start_charging" : "stop_charging";
    try {
      await this.withToken(
        (token) => import_axios.default.post(
          `${API_URL}/tronity/vehicles/${this.config.vehicle_id}/control/${action}`,
          {},
          { headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT_MS }
        )
      );
      this.log.info(start ? "Charging start requested" : "Charging stop requested");
      await this.setState("command.Charging", start, true);
    } catch (e) {
      this.log.error(`Could not ${start ? "start" : "stop"} charging: ${formatError(e)}`);
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Tronity(options);
} else {
  (() => new Tronity())();
}
//# sourceMappingURL=main.js.map
