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
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_got = __toESM(require("got"));
var cache = __toESM(require("memory-cache"));
class Tronity extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "tronity"
    });
    this.timeout = null;
    this.URL = "https://api.tronity.tech";
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    this.log.debug("Starting");
    this.subscribeStates("command.*");
    await this.setStateAsync("info.connection", false, true);
    if (this.config.client_id && this.config.client_secret && this.config.vehicle_id) {
      await this.setStateAsync("info.connection", true, true);
      await this.initSetObject("command.Charging", "boolean", "switch");
      await this.initSetObject("odometer", "number", "level");
      await this.initSetObject("range", "number", "level");
      await this.initSetObject("level", "number", "level");
      await this.initSetObject("charging", "string", "text");
      await this.initSetObject("power", "number", "level");
      await this.initSetObject("chargeRemainingTime", "number", "value.time");
      await this.initSetObject("plugged", "boolean", "switch");
      await this.initSetObject("chargerPower", "number", "level");
      await this.initSetObject("latitude", "number", "value.gps.longitude");
      await this.initSetObject("longitude", "number", "value.gps.latitude");
      await this.initSetObject("timestamp", "number", "value.time");
      await this.initSetObject("lastUpdate", "number", "value.time");
      await this.setStateAsync("info.connection", true, true);
      await this.setStateAsync("command.Charging", false);
      await this.updateVehicleData();
    }
  }
  async initSetObject(name, type, role) {
    return this.setObjectNotExistsAsync(name, {
      type: "state",
      common: {
        name,
        type,
        role,
        write: true,
        read: true
      },
      native: {}
    });
  }
  async getToken() {
    try {
      if (cache.get(this.config.client_id)) {
        return cache.get(this.config.client_id);
      }
      const token = await import_got.default.post(`${this.URL}/authentication`, {
        json: {
          client_id: this.config.client_id,
          client_secret: this.config.client_secret,
          grant_type: "app"
        }
      }).json();
      cache.put(this.config.client_id, token.access_token, token.expires_in - 120);
      return token.access_token;
    } catch (e) {
      this.log.error(e);
      throw Error(e);
    }
  }
  async updateVehicleData() {
    try {
      if (this.config.vehicle_id) {
        const token = await this.getToken();
        const status = await import_got.default.get(`${this.URL}/tronity/vehicles/${this.config.vehicle_id}/last_record`, {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }).json();
        if (status.odometer > -1)
          this.setState("odometer", status.odometer, true);
        if (status.range > -1)
          this.setState("range", status.range, true);
        if (status.level > -1)
          this.setState("level", status.level, true);
        if (status.charging && status.charging.length > 0)
          this.setState("charging", status.charging, true);
        if (status.chargeRemainingTime > 0)
          this.setState("chargeRemainingTime", status.chargeRemainingTime, true);
        if (status.plugged !== null)
          this.setState("plugged", status.plugged, true);
        if (status.chargerPower > 0)
          this.setState("chargerPower", status.chargerPower, true);
        if (status.latitude !== null)
          this.setState("latitude", status.latitude, true);
        if (status.longitude !== null)
          this.setState("longitude", status.longitude, true);
        if (status.timestamp)
          this.setState(
            "timestamp",
            typeof status.timestamp === "number" ? status.timestamp : new Date(status.timestamp).getTime(),
            true
          );
        if (status.lastUpdate)
          this.setState(
            "lastUpdate",
            typeof status.lastUpdate === "number" ? status.lastUpdate : new Date(status.lastUpdate).getTime(),
            true
          );
      }
    } catch (e) {
      this.log.error(e);
    }
    this.timeout = setTimeout(() => this.updateVehicleData(), 60 * 1e3);
  }
  async onMessage(msg) {
    if (msg.command === "validate") {
      const client_id = msg.message.client_id;
      const client_secret = msg.message.client_secret;
      this.log.info("Try to validate login data and get vehicles");
      try {
        const token = await import_got.default.post(`${this.URL}/authentication`, {
          json: {
            client_id,
            client_secret,
            grant_type: "app"
          }
        }).json();
        const vehicles = await import_got.default.get(`${this.URL}/tronity/vehicles?limit=1000`, {
          headers: {
            Authorization: `Bearer ${token.access_token}`
          }
        }).json();
        this.sendTo(msg.from, msg.command, { success: true, vehicles: vehicles.data }, msg.callback);
      } catch (e) {
        this.log.error(e);
        this.sendTo(msg.from, msg.command, { success: false }, msg.callback);
      }
    }
  }
  onUnload(callback) {
    try {
      if (this.timeout)
        clearTimeout(this.timeout);
      callback();
    } catch (e) {
      callback();
    }
  }
  async onStateChange(id, state) {
    if (!state)
      return;
    this.log.debug(`State Change: ${id} to ${state.val} ack ${state.ack}`);
    if (this.config.vehicle_id && state.ack === false) {
      const currentId = id.substring(this.namespace.length + 1);
      switch (currentId) {
        case "command.Charging":
          if (state.val) {
            try {
              const token = await this.getToken();
              await import_got.default.post(
                `${this.URL}/tronity/vehicles/${this.config.vehicle_id}/control/start_charging`,
                {
                  headers: {
                    Authorization: `Bearer ${token}`
                  }
                }
              );
              this.log.info("Try to start charging!");
            } catch (e) {
              this.log.error(e);
            }
          } else {
            try {
              const token = await this.getToken();
              await import_got.default.post(
                `${this.URL}/tronity/vehicles/${this.config.vehicle_id}/control/stop_charging`,
                {
                  headers: {
                    Authorization: `Bearer ${token}`
                  }
                }
              );
              this.log.info("Try to stop charging!");
            } catch (e) {
              this.log.error(e);
            }
          }
          break;
      }
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Tronity(options);
} else {
  (() => new Tronity())();
}
//# sourceMappingURL=main.js.map
