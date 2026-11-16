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
    name: ioBroker.StringOrTranslated;
    type: ioBroker.CommonType;
    role: string;
    unit?: string;
    write?: boolean;
}

const STATES: StateDefinition[] = [
    {
        id: 'command.Charging',
        name: { en: 'Start/stop charging', de: 'Laden starten/stoppen' },
        type: 'boolean',
        role: 'switch',
        write: true,
    },
    {
        id: 'odometer',
        name: { en: 'Odometer', de: 'Kilometerstand' },
        type: 'number',
        role: 'value.distance',
        unit: 'km',
    },
    { id: 'range', name: { en: 'Range', de: 'Reichweite' }, type: 'number', role: 'value.distance', unit: 'km' },
    { id: 'level', name: { en: 'Battery level', de: 'Akkustand' }, type: 'number', role: 'value.battery', unit: '%' },
    { id: 'charging', name: { en: 'Charging status', de: 'Ladestatus' }, type: 'string', role: 'text' },
    {
        id: 'chargeRemainingTime',
        name: { en: 'Remaining charging time', de: 'Restladezeit' },
        type: 'number',
        role: 'value',
    },
    { id: 'plugged', name: { en: 'Plugged in', de: 'Ladekabel eingesteckt' }, type: 'boolean', role: 'indicator' },
    {
        id: 'chargerPower',
        name: { en: 'Charging power', de: 'Ladeleistung' },
        type: 'number',
        role: 'value.power',
        unit: 'kW',
    },
    {
        id: 'latitude',
        name: { en: 'Latitude', de: 'Breitengrad' },
        type: 'number',
        role: 'value.gps.latitude',
        unit: '°',
    },
    {
        id: 'longitude',
        name: { en: 'Longitude', de: 'Längengrad' },
        type: 'number',
        role: 'value.gps.longitude',
        unit: '°',
    },
    {
        id: 'timestamp',
        name: { en: 'Time of the record', de: 'Zeitpunkt des Datensatzes' },
        type: 'number',
        role: 'value.time',
    },
    { id: 'lastUpdate', name: { en: 'Last update', de: 'Letzte Aktualisierung' }, type: 'number', role: 'value.time' },
];

/** States created by older versions that are no longer used (outTemp/elevation are not part of the TRONITY API) */
const OBSOLETE_STATES = ['power', 'outTemp', 'elevation'];

interface VehicleRecord {
    odometer?: number | null;
    range?: number | null;
    level?: number | null;
    charging?: string | null;
    chargeRemainingTime?: number | null;
    plugged?: boolean | null;
    chargerPower?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    timestamp?: number | string | null;
    lastUpdate?: number | string | null;
}

interface Vehicle {
    id: string;
    displayName: string;
    manufacture: string;
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

/** Meaning of the HTTP status codes documented in the TRONITY Platform API */
const HTTP_HINTS: Record<number, string> = {
    400: 'credentials are not valid',
    401: 'token or credentials are incorrect',
    403: 'insufficient permissions - check the scopes of your app in the TRONITY Platform',
    405: 'not supported by this vehicle',
    409: 'vehicle may be unreachable',
};

function formatError(e: any): string {
    if (e?.response) {
        const status = e.response.status;
        const hint = HTTP_HINTS[status] ? ` (${HTTP_HINTS[status]})` : '';
        return `HTTP ${status}${hint} on ${e.config?.url ?? 'unknown URL'}: ${JSON.stringify(e.response.data)}`;
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

            await this.extendObjectAsync('command', {
                type: 'channel',
                common: { name: { en: 'Commands', de: 'Befehle' } },
                native: {},
            });
            for (const def of STATES) {
                await this.extendObjectAsync(def.id, {
                    type: 'state',
                    common: {
                        name: def.name,
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
        // compare with the stored value instead of a local cache: js-controller may reset it to false
        await this.setStateChangedAsync('info.connection', connected, true);
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
        this.log.debug(`last_record: ${JSON.stringify(status)}`);

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
        const timestamp = toEpochMs(status.timestamp);
        if (timestamp !== null) {
            await this.setState('timestamp', timestamp, true);
        }
        const lastUpdate = toEpochMs(status.lastUpdate);
        if (lastUpdate !== null) {
            await this.setState('lastUpdate', lastUpdate, true);
        }
    }

    private async fetchVehicles(client_id: string, client_secret: string): Promise<Vehicle[]> {
        const token = await this.requestToken(client_id, client_secret);
        const response = await axios.get(`${API_URL}/tronity/vehicles?limit=1000`, {
            headers: { Authorization: `Bearer ${token.access_token}` },
            timeout: REQUEST_TIMEOUT_MS,
        });
        return (response.data as { data?: Vehicle[] }).data ?? [];
    }

    private async onMessage(msg: ioBroker.Message): Promise<void> {
        if (msg.command !== 'validate' && msg.command !== 'testConnection') {
            return;
        }
        // The admin form sends the current (possibly unsaved) values via jsonData; fall back to the saved config
        const message = (msg.message ?? {}) as { client_id?: string; client_secret?: string };
        const client_id = message.client_id || this.config.client_id;
        const client_secret = message.client_secret || this.config.client_secret;

        if (msg.command === 'testConnection') {
            await this.testConnection(msg, client_id, client_secret);
            return;
        }

        if (!client_id || !client_secret) {
            // nothing entered yet - no need to call the API
            this.sendTo(msg.from, msg.command, [], msg.callback);
            return;
        }
        this.log.info('Try to validate login data and get vehicles');
        try {
            const vehicles = await this.fetchVehicles(client_id, client_secret);
            // Return [{label, value}] array as required by the selectSendTo component
            const options = vehicles.map(v => ({
                label: `${v.manufacture} ${v.displayName}`,
                value: v.id,
            }));
            this.sendTo(msg.from, msg.command, options, msg.callback);
        } catch (e: any) {
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
    private async testConnection(msg: ioBroker.Message, client_id: string, client_secret: string): Promise<void> {
        if (!client_id || !client_secret) {
            this.sendTo(
                msg.from,
                msg.command,
                { error: 'Please enter client ID and client secret first.' },
                msg.callback,
            );
            return;
        }
        try {
            const vehicles = await this.fetchVehicles(client_id, client_secret);
            this.log.info(`Login data valid, ${vehicles.length} vehicle(s) found`);
            this.sendTo(msg.from, msg.command, { result: 'ok', args: [String(vehicles.length)] }, msg.callback);
        } catch (e: any) {
            this.log.warn(`Login data check failed: ${formatError(e)}`);
            const error =
                isUnauthorized(e) || e?.response?.status === 400
                    ? 'Login failed. Please check client ID and client secret.'
                    : `Connection to TRONITY failed: ${e?.response ? `HTTP ${e.response.status}` : (e?.message ?? String(e))}`;
            this.sendTo(msg.from, msg.command, { error }, msg.callback);
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
