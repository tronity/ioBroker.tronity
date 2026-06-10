class FakeAdapter {
    public config: Record<string, unknown> = {};
    public namespace = 'tronity.0';
    public log = {
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
    };

    public on = jest.fn();
    public sendTo = jest.fn();
    public subscribeStates = jest.fn();
    public setStateAsync = jest.fn().mockResolvedValue(undefined);
    public setObjectNotExistsAsync = jest.fn().mockResolvedValue(undefined);
    public setState = jest.fn();

    public constructor(_options: unknown) {
        // no-op
    }
}

function loadAdapter() {
    jest.resetModules();

    const axiosPost = jest.fn();
    const axiosGet = jest.fn();
    const cacheGet = jest.fn();
    const cachePut = jest.fn();

    jest.doMock('@iobroker/adapter-core', () => ({ Adapter: FakeAdapter }));
    jest.doMock('axios', () => ({ __esModule: true, default: { post: axiosPost, get: axiosGet } }));
    jest.doMock('memory-cache', () => ({ get: cacheGet, put: cachePut }));

    const createAdapter = require('../src/main') as (options?: Record<string, unknown>) => FakeAdapter;
    const adapter = createAdapter();

    return { adapter, axiosPost, axiosGet, cacheGet, cachePut };
}

describe('Tronity adapter (Jest)', () => {
    it('returns vehicle options on validate message', async () => {
        const { adapter, axiosPost, axiosGet } = loadAdapter();
        axiosPost.mockResolvedValue({ data: { access_token: 'token-1', expires_in: 3600 } });
        axiosGet.mockResolvedValue({
            data: {
                data: [{ id: 'veh-1', displayName: 'ID.3', manufacture: 'VW' }],
            },
        });

        await (adapter as unknown as { onMessage: (msg: unknown) => Promise<void> }).onMessage({
            command: 'validate',
            message: {
                client_id: 'client-id',
                client_secret: 'client-secret',
            },
            from: 'system.adapter.admin.0',
            callback: 'cb-id',
        });

        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(axiosGet).toHaveBeenCalledTimes(1);
        expect(adapter.sendTo).toHaveBeenCalledTimes(1);
        expect(adapter.sendTo.mock.calls[0][2]).toEqual([{ label: 'VW ID.3', value: 'veh-1' }]);
    });

    it('returns empty options on validate error', async () => {
        const { adapter, axiosPost } = loadAdapter();
        axiosPost.mockRejectedValue(new Error('auth failed'));

        await (adapter as unknown as { onMessage: (msg: unknown) => Promise<void> }).onMessage({
            command: 'validate',
            message: {
                client_id: 'client-id',
                client_secret: 'client-secret',
            },
            from: 'system.adapter.admin.0',
            callback: 'cb-id',
        });

        expect(adapter.sendTo).toHaveBeenCalledTimes(1);
        expect(adapter.sendTo.mock.calls[0][2]).toEqual([]);
        expect(adapter.log.error).toHaveBeenCalledTimes(1);
    });

    it('starts charging when command.Charging is true', async () => {
        const { adapter, axiosPost, cacheGet } = loadAdapter();
        cacheGet.mockReturnValue('cached-token');
        adapter.config = {
            client_id: 'client-id',
            vehicle_id: 'veh-1',
        };

        await (
            adapter as unknown as { onStateChange: (id: string, state: ioBroker.State) => Promise<void> }
        ).onStateChange(`${adapter.namespace}.command.Charging`, { val: true, ack: false } as ioBroker.State);

        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(String(axiosPost.mock.calls[0][0])).toContain('/control/start_charging');
    });

    it('stops charging when command.Charging is false', async () => {
        const { adapter, axiosPost, cacheGet } = loadAdapter();
        cacheGet.mockReturnValue('cached-token');
        adapter.config = {
            client_id: 'client-id',
            vehicle_id: 'veh-1',
        };

        await (
            adapter as unknown as { onStateChange: (id: string, state: ioBroker.State) => Promise<void> }
        ).onStateChange(`${adapter.namespace}.command.Charging`, { val: false, ack: false } as ioBroker.State);

        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(String(axiosPost.mock.calls[0][0])).toContain('/control/stop_charging');
    });
});
