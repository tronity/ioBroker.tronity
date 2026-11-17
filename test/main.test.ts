class FakeAdapter {
    public config: Record<string, unknown> = {};
    public namespace = 'tronity.0';
    public log = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };

    public on = jest.fn();
    public sendTo = jest.fn();
    public setState = jest.fn().mockResolvedValue(undefined);
    public setStateChangedAsync = jest.fn().mockResolvedValue(undefined);
    public extendObjectAsync = jest.fn().mockResolvedValue(undefined);
    public getObjectAsync = jest.fn().mockResolvedValue(null);
    public delObjectAsync = jest.fn().mockResolvedValue(undefined);
    public setTimeout = jest.fn().mockReturnValue('timer');
    public clearTimeout = jest.fn();

    public constructor(_options: unknown) {
        // no-op
    }
}

type Internals = {
    onReady: () => Promise<void>;
    onMessage: (msg: unknown) => Promise<void>;
    onUnload: (cb: () => void) => void;
    poll: () => Promise<void>;
};

type LoadedAdapter = {
    adapter: FakeAdapter & Internals;
    axiosPost: jest.Mock;
    axiosGet: jest.Mock;
};

const CONFIG = { client_id: 'client-id', client_secret: 'client-secret', vehicle_id: 'veh-1', interval: 60 };

async function loadAdapter(): Promise<LoadedAdapter> {
    jest.resetModules();

    const axiosPost = jest.fn();
    const axiosGet = jest.fn();

    jest.doMock('@iobroker/adapter-core', () => ({ Adapter: FakeAdapter }));
    jest.doMock('axios', () => ({ __esModule: true, default: { post: axiosPost, get: axiosGet } }));

    const mainModule = (await import('../src/main')) as unknown as {
        default?: (options?: Record<string, unknown>) => FakeAdapter;
    };
    const createAdapter = mainModule.default as (options?: Record<string, unknown>) => FakeAdapter;
    const adapter = createAdapter() as FakeAdapter & Internals;

    return { adapter, axiosPost, axiosGet };
}

function stateValue(adapter: FakeAdapter, id: string): unknown {
    const mock = id === 'info.connection' ? adapter.setStateChangedAsync : adapter.setState;
    const calls = mock.mock.calls.filter(c => c[0] === id);
    return calls.length ? calls[calls.length - 1][1] : undefined;
}

function httpError(status: number): Error {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status, data: {} },
        config: { url: 'https://api.tronity.tech/x' },
    });
}

const TOKEN = { data: { access_token: 'token-1', expires_in: 3600 } };

describe('Tronity adapter (Jest)', () => {
    it('returns vehicle options on validate message', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({
            data: {
                data: [{ id: 'veh-1', displayName: 'ID.3', manufacture: 'VW' }],
            },
        });

        await adapter.onMessage({
            command: 'validate',
            message: { client_id: 'client-id', client_secret: 'client-secret' },
            from: 'system.adapter.admin.0',
            callback: 'cb-id',
        });

        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(axiosGet).toHaveBeenCalledTimes(1);
        expect(adapter.sendTo).toHaveBeenCalledTimes(1);
        expect(adapter.sendTo.mock.calls[0][2]).toEqual([{ label: 'VW ID.3', value: 'veh-1' }]);
    });

    it('returns empty options on validate error', async () => {
        const { adapter, axiosPost } = await loadAdapter();
        axiosPost.mockRejectedValue(new Error('auth failed'));

        await adapter.onMessage({
            command: 'validate',
            message: { client_id: 'client-id', client_secret: 'client-secret' },
            from: 'system.adapter.admin.0',
            callback: 'cb-id',
        });

        expect(adapter.sendTo).toHaveBeenCalledTimes(1);
        expect(adapter.sendTo.mock.calls[0][2]).toEqual([]);
        expect(adapter.log.error).toHaveBeenCalledWith(expect.stringContaining('auth failed'));
    });

    it('does not call the API for the vehicle list without credentials', async () => {
        const { adapter, axiosPost } = await loadAdapter();

        await adapter.onMessage({ command: 'validate', message: null, from: 'admin', callback: 'cb' });

        expect(axiosPost).not.toHaveBeenCalled();
        expect(adapter.sendTo.mock.calls[0][2]).toEqual([]);
    });

    it('reports the number of vehicles on testConnection', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({ data: { data: [{ id: 'a' }, { id: 'b' }] } });

        await adapter.onMessage({
            command: 'testConnection',
            message: { client_id: 'client-id', client_secret: 'client-secret' },
            from: 'admin',
            callback: 'cb',
        });

        expect(axiosPost.mock.calls[0][1]).toMatchObject({ client_id: 'client-id', client_secret: 'client-secret' });
        expect(adapter.sendTo.mock.calls[0][2]).toEqual({ result: 'ok', args: ['2'] });
    });

    it('reports invalid credentials on testConnection', async () => {
        const { adapter, axiosPost } = await loadAdapter();
        axiosPost.mockRejectedValue(httpError(401));

        await adapter.onMessage({
            command: 'testConnection',
            message: { client_id: 'client-id', client_secret: 'wrong' },
            from: 'admin',
            callback: 'cb',
        });

        expect(adapter.sendTo.mock.calls[0][2]).toEqual({
            error: 'Login failed. Please check client ID and client secret.',
        });
    });

    it('asks for credentials on testConnection when fields are empty', async () => {
        const { adapter, axiosPost } = await loadAdapter();

        await adapter.onMessage({
            command: 'testConnection',
            message: { client_id: '', client_secret: '' },
            from: 'admin',
            callback: 'cb',
        });

        expect(axiosPost).not.toHaveBeenCalled();
        expect(adapter.sendTo.mock.calls[0][2]).toEqual({ error: 'Please enter client ID and client secret first.' });
    });

    it('warns and does not poll when configuration is incomplete', async () => {
        const { adapter, axiosGet } = await loadAdapter();
        adapter.config = { client_id: 'client-id' };

        await adapter.onReady();

        expect(adapter.log.warn).toHaveBeenCalledWith(expect.stringContaining('client_secret, vehicle_id'));
        expect(axiosGet).not.toHaveBeenCalled();
        expect(adapter.setStateChangedAsync).toHaveBeenCalledWith('info.connection', false, true);
    });

    it('creates read-only value states, deletes obsolete ones and polls on start', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        adapter.getObjectAsync.mockResolvedValue({ _id: 'tronity.0.power' });
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({ data: { level: 80 } });

        await adapter.onReady();

        const odometer = adapter.extendObjectAsync.mock.calls.find(c => c[0] === 'odometer');
        expect(odometer[1].common).toMatchObject({ write: false, role: 'value.distance', unit: 'km' });
        expect(adapter.extendObjectAsync.mock.calls.every(c => c[1].common.write === false)).toBe(true);
        expect(adapter.delObjectAsync).toHaveBeenCalledWith('power');
        expect(adapter.delObjectAsync).toHaveBeenCalledWith('outTemp');
        expect(adapter.delObjectAsync).toHaveBeenCalledWith('elevation');
        expect(adapter.delObjectAsync).toHaveBeenCalledWith('command.Charging');
        expect(adapter.delObjectAsync).toHaveBeenCalledWith('command');
        expect(stateValue(adapter, 'level')).toBe(80);
        expect(stateValue(adapter, 'info.connection')).toBe(true);
        expect(adapter.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
    });

    it('resets charging values when the car is disconnected', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({
            data: { charging: 'Disconnected', plugged: false, chargerPower: 11, chargeRemainingTime: 30 },
        });

        await adapter.poll();

        expect(stateValue(adapter, 'chargerPower')).toBe(0);
        expect(stateValue(adapter, 'chargeRemainingTime')).toBe(0);
        expect(stateValue(adapter, 'plugged')).toBe(false);
    });

    it('reports charging status and remaining time while charging', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        axiosPost.mockResolvedValue(TOKEN);
        // real response of a VW Passat GTE while charging
        axiosGet.mockResolvedValue({
            data: { charging: 'Charging', plugged: true, chargerPower: null, chargeRemainingTime: 34800, level: 1 },
        });

        await adapter.poll();

        expect(stateValue(adapter, 'charging')).toBe('Charging');
        expect(stateValue(adapter, 'chargeRemainingTime')).toBe(34800);
    });

    it('writes zero charger power while plugged in', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({ data: { charging: 'Complete', plugged: true, chargerPower: 0 } });

        await adapter.poll();

        expect(stateValue(adapter, 'chargerPower')).toBe(0);
    });

    it('skips missing and invalid values', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({
            data: {
                odometer: null,
                range: -1,
                latitude: undefined,
                timestamp: 'not a date',
                lastUpdate: '2026-01-01T00:00:00Z',
            },
        });

        await adapter.poll();

        for (const id of ['odometer', 'range', 'latitude', 'plugged', 'timestamp']) {
            expect(stateValue(adapter, id)).toBeUndefined();
        }
        expect(stateValue(adapter, 'lastUpdate')).toBe(Date.parse('2026-01-01T00:00:00Z'));
    });

    it('sets info.connection to false and keeps polling when the API fails', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(httpError(503));

        await adapter.poll();
        await adapter.poll();

        expect(stateValue(adapter, 'info.connection')).toBe(false);
        expect(adapter.setTimeout).toHaveBeenCalledTimes(2);
    });

    it('writes info.connection on every successful poll (js-controller may reset it)', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({ data: {} });

        await adapter.poll();
        await adapter.poll();

        const calls = adapter.setStateChangedAsync.mock.calls.filter(c => c[0] === 'info.connection');
        expect(calls).toEqual([
            ['info.connection', true, true],
            ['info.connection', true, true],
        ]);
    });

    it('creates readable state names', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({ data: {} });

        await adapter.onReady();

        const level = adapter.extendObjectAsync.mock.calls.find(c => c[0] === 'level');
        expect(level[1].common.name).toMatchObject({ en: 'Battery level', de: 'Akkustand' });
    });

    it('renews the token once on HTTP 401', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet
            .mockResolvedValueOnce({ data: {} })
            .mockRejectedValueOnce(httpError(401))
            .mockResolvedValueOnce({
                data: { level: 50 },
            });

        await adapter.poll();
        await adapter.poll();

        expect(axiosPost).toHaveBeenCalledTimes(2);
        expect(stateValue(adapter, 'level')).toBe(50);
    });

    it('uses a request timeout for all API calls', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({ data: {} });

        await adapter.poll();

        expect(axiosPost.mock.calls[0][2]).toMatchObject({ timeout: expect.any(Number) });
        expect(axiosGet.mock.calls[0][1]).toMatchObject({ timeout: expect.any(Number) });
    });

    it('enforces the minimum polling interval', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG, interval: 5 };
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({ data: {} });

        await adapter.poll();

        expect(adapter.setTimeout).toHaveBeenCalledWith(expect.any(Function), 30_000);
    });

    it('does not schedule a new poll after unload', async () => {
        const { adapter, axiosPost, axiosGet } = await loadAdapter();
        adapter.config = { ...CONFIG };
        axiosPost.mockResolvedValue(TOKEN);
        axiosGet.mockResolvedValue({ data: {} });
        const callback = jest.fn();

        adapter.onUnload(callback);
        await adapter.poll();

        expect(callback).toHaveBeenCalled();
        expect(adapter.setTimeout).not.toHaveBeenCalled();
    });
});
