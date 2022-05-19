import * as utils from '@iobroker/adapter-core';
import got from 'got';
import * as cache from 'memory-cache';

class Tronity extends utils.Adapter {
	private timeout: any = null;
	private URL = 'https://api.tronity.tech';

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
		this.log.debug('Starting');
		this.subscribeStates('command.*');
		await this.setStateAsync('info.connection', false, true);
		if (this.config.client_id && this.config.client_secret && this.config.vehicle_id) {
			await this.setStateAsync('info.connection', true, true);
			await this.initSetObject('command.Charging', 'boolean', 'switch');
			await this.initSetObject('odometer', 'number', 'level');
			await this.initSetObject('range', 'number', 'level');
			await this.initSetObject('level', 'number', 'level');
			await this.initSetObject('charging', 'string', 'text');
			await this.initSetObject('power', 'number', 'level');
			await this.initSetObject('chargeRemainingTime', 'number', 'value.time');
			await this.initSetObject('plugged', 'boolean', 'switch');
			await this.initSetObject('chargerPower', 'number', 'level');
			await this.initSetObject('latitude', 'number', 'value.gps.longitude');
			await this.initSetObject('longitude', 'number', 'value.gps.latitude');
			await this.initSetObject('timestamp', 'number', 'value.time');
			await this.initSetObject('lastUpdate', 'number', 'value.time');

			await this.setStateAsync('info.connection', true, true);
			await this.setStateAsync('command.Charging', false);
			await this.updateVehicleData();
		}
	}

	private async initSetObject(name: string, type: any, role: string): Promise<any> {
		return this.setObjectNotExistsAsync(name, {
			type: 'state',
			common: {
				name,
				type,
				role,
				write: true,
				read: true,
			},
			native: {},
		});
	}

	private async getToken(): Promise<string> {
		try {
			if (cache.get(this.config.client_id)) {
				return cache.get(this.config.client_id);
			}
			const token = (await got
				.post(`${this.URL}/authentication`, {
					json: {
						client_id: this.config.client_id,
						client_secret: this.config.client_secret,
						grant_type: 'app',
					},
				})
				.json()) as {
				access_token: string;
				expires_in: number;
			};
			cache.put(this.config.client_id, token.access_token, token.expires_in - 120);
			return token.access_token;
		} catch (e: any) {
			this.log.error(e);
			throw Error(e);
		}
	}

	private async updateVehicleData(): Promise<void> {
		try {
			if (this.config.vehicle_id) {
				const token = await this.getToken();
				const status = (await got
					.get(`${this.URL}/tronity/vehicles/${this.config.vehicle_id}/last_record`, {
						headers: {
							Authorization: `Bearer ${token}`,
						},
					})
					.json()) as {
					odometer: number;
					range: number;
					level: number;
					charging: string;
					chargeRemainingTime: number;
					plugged: boolean;
					chargerPower: number;
					latitude: number;
					longitude: number;
					timestamp: number;
					lastUpdate: number;
				};
				if (status.odometer > -1) this.setState('odometer', status.odometer, true);
				if (status.range > -1) this.setState('range', status.range, true);
				if (status.level > -1) this.setState('level', status.level, true);
				if (status.charging && status.charging.length > 0) this.setState('charging', status.charging, true);
				if (status.chargeRemainingTime > 0)
					this.setState('chargeRemainingTime', status.chargeRemainingTime, true);
				if (status.plugged !== null) this.setState('plugged', status.plugged, true);
				if (status.chargerPower > 0) this.setState('chargerPower', status.chargerPower, true);
				if (status.latitude !== null) this.setState('latitude', status.latitude, true);
				if (status.longitude !== null) this.setState('longitude', status.longitude, true);
				if (status.timestamp)
					this.setState(
						'timestamp',
						typeof status.timestamp === 'number' ? status.timestamp : new Date(status.timestamp).getTime(),
						true,
					);
				if (status.lastUpdate)
					this.setState(
						'lastUpdate',
						typeof status.lastUpdate === 'number'
							? status.lastUpdate
							: new Date(status.lastUpdate).getTime(),
						true,
					);
			}
		} catch (e: any) {
			this.log.error(e);
		}
		this.timeout = setTimeout(() => this.updateVehicleData(), 60 * 1000);
	}

	private async onMessage(msg: any): Promise<void> {
		if (msg.command === 'validate') {
			const client_id = msg.message.client_id;
			const client_secret = msg.message.client_secret;

			this.log.info('Try to validate login data and get vehicles');
			try {
				const token = (await got
					.post(`${this.URL}/authentication`, {
						json: {
							client_id,
							client_secret,
							grant_type: 'app',
						},
					})
					.json()) as {
					access_token: string;
					expires_in: number;
				};
				const vehicles = (await got
					.get(`${this.URL}/tronity/vehicles?limit=1000`, {
						headers: {
							Authorization: `Bearer ${token.access_token}`,
						},
					})
					.json()) as {
					data: [];
				};
				this.sendTo(msg.from, msg.command, { success: true, vehicles: vehicles.data }, msg.callback);
			} catch (e: any) {
				this.log.error(e);
				this.sendTo(msg.from, msg.command, { success: false }, msg.callback);
			}
		}
	}

	private onUnload(callback: () => void): void {
		try {
			if (this.timeout) clearTimeout(this.timeout);
			callback();
		} catch (e) {
			callback();
		}
	}

	private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
		if (!state) return;
		this.log.debug(`State Change: ${id} to ${state.val} ack ${state.ack}`);

		if (this.config.vehicle_id && state.ack === false) {
			const currentId = id.substring(this.namespace.length + 1);
			switch (currentId) {
				case 'command.Charging':
					if (state.val) {
						try {
							const token = await this.getToken();
							await got.post(
								`${this.URL}/tronity/vehicles/${this.config.vehicle_id}/control/start_charging`,
								{
									headers: {
										Authorization: `Bearer ${token}`,
									},
								},
							);
							this.log.info('Try to start charging!');
						} catch (e: any) {
							this.log.error(e);
						}
					} else {
						try {
							const token = await this.getToken();
							await got.post(
								`${this.URL}/tronity/vehicles/${this.config.vehicle_id}/control/stop_charging`,
								{
									headers: {
										Authorization: `Bearer ${token}`,
									},
								},
							);
							this.log.info('Try to stop charging!');
						} catch (e: any) {
							this.log.error(e);
						}
					}
					break;
			}
		}
	}
}

if (require.main !== module) {
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Tronity(options);
} else {
	(() => new Tronity())();
}
