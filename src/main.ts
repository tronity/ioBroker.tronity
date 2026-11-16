import * as utils from '@iobroker/adapter-core';
import axios from 'axios';

const API_URL = 'https://api.tronity.tech';
/** Abort HTTP requests that hang, otherwise polling would stop forever */
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 30;
/** Refresh the access token this long before it expires */
const TOKEN_EXPIRY_MARGIN_MS = 120_000;

interface StateDefinition {
    id: string;
    type: ioBroker.CommonType;
    role: string;
    unit?: string;
    write?: boolean;
}

const STATES: StateDefinition[] = [
    { id: 'command.Charging', type: 'boolean', role: 'switch', write: true },
    { id: 'odometer', type: 'number', role: 'value.distance', unit: 'km' },
    { id: 'range', type: 'number', role: 'value.distance', unit: 'km' },
    { id: 'level', type: 'number', role: 'value.battery', unit: '%' },
    { id: 'charging', type: 'string', role: 'text' },
    { id: 'chargeRemainingTime', type: 'number', role: 'value' },
    { id: 'plugged', type: 'boolean', role: 'indicator' },
    { id: 'chargerPower', type: 'number', role: 'value.power', unit: 'kW' },
    { id: 'latitude', type: 'number', role: 'value.gps.latitude', unit: '°' },
    { id: 'longitude', type: 'number', role: 'value.gps.longitude', unit: '°' },
    { id: 'outTemp', type: 'number', role: 'value.temperature', unit: '°C' },
    { id: 'elevation', type: 'number', role: 'value.gps.elevation', unit: 'm' },
    { id: 'timestamp', type: 'number', role: 'value.time' },
    { id: 'lastUpdate', type: 'number', role: 'value.time' },
];

/** States created by older versions that are no longer used */
const OBSOLETE_STATES = ['power'];

interface VehicleRecord {
    odometer?: number | null;
    range?: number | null;
    level?: number | null;
    charging?: string | null;
    chargeRemainingTime?: number | null;
    plugged?: boolean | null;
    chargerPower?: number | null;
    outTemp?: number | null;
    elevation?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    timestamp?: number | string | null;
    lastUpdate?: number | string | null;
}

interface TokenResponse {
    access_token: string;
    expires_in: number;
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function toEpochMs(value: unknown): number | null {
    if (isNumber(value)) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const ms = new Date(value).getTime();
        return Number.isNaN(ms) ? null : ms;
    }
    return null;
}

function formatError(e: any): string {
    if (e?.response) {
        return `HTTP ${e.response.status} on ${e.config?.url ?? 'unknown URL'}: ${JSON.stringify(e.response.data)}`;
    }
    return e?.message ?? String(e);
}

function isUnauthorized(e: any): boolean {
    return e?.response?.status === 401;
}

class Tronity extends utils.Adapter {
    private pollTimer: ioBroker.Timeout | undefined = undefined;
    private unloading = false;
    private token: { value: string; expiresAt: number } | undefined = undefined;
    private lastConnectionState: boolean | undefined = undefined;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'tronity',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        try {
            await this.setConnected(false);

            const missing = (['client_id', 'client_secret', 'vehicle_id'] as const).filter(key => !this.config[key]);
            if (missing.length > 0) {
                this.log.warn(
                    `Adapter is not configured completely (missing: ${missing.join(', ')}). ` +
                        'Please enter client ID and secret, then select a vehicle in the instance settings.',
                );
                return;
            }

            for (const def of STATES) {
                await this.extendObjectAsync(def.id, {
                    type: 'state',
                    common: {
                        name: def.id,
                        type: def.type,
                        role: def.role,
                        read: true,
                        write: def.write ?? false,
                        ...(def.unit ? { unit: def.unit } : {}),
                    },
                    native: {},
                });
            }
            for (const id of OBSOLETE_STATES) {
                if (await this.getObjectAsync(id)) {
                    await this.delObjectAsync(id);
                }
            }

            this.subscribeStates('command.*');
            await this.poll();
        } catch (e: any) {
            this.log.error(`Error during startup: ${formatError(e)}`);
        }
    }

    private getIntervalMs(): number {
        const configured = Number(this.config.interval);
        const seconds = isNumber(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_S;
        return Math.max(seconds, MIN_INTERVAL_S) * 1000;
    }

    private async setConnected(connected: boolean): Promise<void> {
        if (this.lastConnectionState !== connected) {
            this.lastConnectionState = connected;
            await this.setState('info.connection', connected, true);
        }
    }

    private async requestToken(client_id: string, client_secret: string): Promise<TokenResponse> {
        const response = await axios.post(
            `${API_URL}/authentication`,
            { client_id, client_secret, grant_type: 'app' },
            { timeout: REQUEST_TIMEOUT_MS },
        );
        return response.data as TokenResponse;
    }

    private async getToken(): Promise<string> {
        if (this.token && this.token.expiresAt > Date.now()) {
            return this.token.value;
        }
        const token = await this.requestToken(this.config.client_id, this.config.client_secret);
        const lifetimeMs = isNumber(token.expires_in) ? token.expires_in * 1000 : 0;
        this.token = {
            value: token.access_token,
            expiresAt: Date.now() + Math.max(lifetimeMs - TOKEN_EXPIRY_MARGIN_MS, 0),
        };
        return token.access_token;
    }

    /**
     * Runs an authenticated request; on HTTP 401 the token is renewed once and the request repeated.
     *
     * @param request performs the API call with the given access token
     */
    private async withToken<T>(request: (token: string) => Promise<T>): Promise<T> {
        try {
            return await request(await this.getToken());
        } catch (e: any) {
            if (!isUnauthorized(e)) {
                throw e;
            }
            this.token = undefined;
            return request(await this.getToken());
        }
    }

    private async poll(): Promise<void> {
        try {
            await this.updateVehicleData();
            await this.setConnected(true);
        } catch (e: any) {
            this.log.error(`Could not update vehicle data: ${formatError(e)}`);
            await this.setConnected(false).catch(() => undefined);
        }
        if (!this.unloading) {
            this.pollTimer = this.setTimeout(() => {
                void this.poll();
            }, this.getIntervalMs());
        }
    }

    private async updateVehicleData(): Promise<void> {
        const url = `${API_URL}/tronity/vehicles/${this.config.vehicle_id}/last_record`;
        const status = await this.withToken(async token => {
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: REQUEST_TIMEOUT_MS,
            });
            return response.data as VehicleRecord;
        });

        if (isNumber(status.odometer) && status.odometer >= 0) {
            await this.setState('odometer', status.odometer, true);
        }
        if (isNumber(status.range) && status.range >= 0) {
            await this.setState('range', status.range, true);
        }
        if (isNumber(status.level) && status.level >= 0) {
            await this.setState('level', status.level, true);
        }
        if (typeof status.charging === 'string' && status.charging.length > 0) {
            await this.setState('charging', status.charging, true);
        }
        if (typeof status.plugged === 'boolean') {
            await this.setState('plugged', status.plugged, true);
        }

        // Once the car is disconnected, charging values must be reset instead of keeping the last value
        const disconnected = status.charging === 'Disconnected' || status.plugged === false;
        if (disconnected) {
            await this.setState('chargerPower', 0, true);
            await this.setState('chargeRemainingTime', 0, true);
        } else {
            if (isNumber(status.chargerPower) && status.chargerPower >= 0) {
                await this.setState('chargerPower', status.chargerPower, true);
            }
            if (isNumber(status.chargeRemainingTime) && status.chargeRemainingTime >= 0) {
                await this.setState('chargeRemainingTime', status.chargeRemainingTime, true);
            }
        }

        if (isNumber(status.latitude)) {
            await this.setState('latitude', status.latitude, true);
        }
        if (isNumber(status.longitude)) {
            await this.setState('longitude', status.longitude, true);
        }
        if (isNumber(status.outTemp) && status.outTemp > -100) {
            await this.setState('outTemp', status.outTemp, true);
        }
        if (isNumber(status.elevation) && status.elevation > -100) {
            await this.setState('elevation', status.elevation, true);
        }
        const timestamp = toEpochMs(status.timestamp);
        if (timestamp !== null) {
            await this.setState('timestamp', timestamp, true);
        }
        const lastUpdate = toEpochMs(status.lastUpdate);
        if (lastUpdate !== null) {
            await this.setState('lastUpdate', lastUpdate, true);
        }
    }

    private async onMessage(msg: ioBroker.Message): Promise<void> {
        if (msg.command !== 'validate') {
            return;
        }
        // credentials come from the current form values (selectSendTo sends all config fields)
        const message = (msg.message ?? {}) as { client_id?: string; client_secret?: string };
        const client_id = message.client_id || this.config.client_id;
        const client_secret = message.client_secret || this.config.client_secret;

        this.log.info('Try to validate login data and get vehicles');
        try {
            const token = await this.requestToken(client_id, client_secret);
            const response = await axios.get(`${API_URL}/tronity/vehicles?limit=1000`, {
                headers: { Authorization: `Bearer ${token.access_token}` },
                timeout: REQUEST_TIMEOUT_MS,
            });
            const vehicles = response.data as {
                data: Array<{ id: string; displayName: string; manufacture: string }>;
            };
            // Return [{label, value}] array as required by the selectSendTo component
            const options = vehicles.data.map(v => ({
                label: `${v.manufacture} ${v.displayName}`,
                value: v.id,
            }));
            this.sendTo(msg.from, msg.command, options, msg.callback);
        } catch (e: any) {
            this.log.error(`Could not validate login data: ${formatError(e)}`);
            this.sendTo(msg.from, msg.command, [], msg.callback);
        }
    }

    private onUnload(callback: () => void): void {
        try {
            this.unloading = true;
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
                this.pollTimer = undefined;
            }
        } finally {
            callback();
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }
        this.log.debug(`State Change: ${id} to ${state.val} ack ${state.ack}`);

        const localId = id.substring(this.namespace.length + 1);
        if (localId !== 'command.Charging' || !this.config.vehicle_id) {
            return;
        }

        const start = !!state.val;
        const action = start ? 'start_charging' : 'stop_charging';
        try {
            await this.withToken(token =>
                axios.post(
                    `${API_URL}/tronity/vehicles/${this.config.vehicle_id}/control/${action}`,
                    {},
                    { headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT_MS },
                ),
            );
            this.log.info(start ? 'Charging start requested' : 'Charging stop requested');
            // confirm the command so scripts and visualisations know it was accepted
            await this.setState('command.Charging', start, true);
        } catch (e: any) {
            this.log.error(`Could not ${start ? 'start' : 'stop'} charging: ${formatError(e)}`);
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Tronity(options);
} else {
    (() => new Tronity())();
}
