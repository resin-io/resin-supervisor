import { stripIndent } from 'common-tags';
import { fs } from 'mz';
import { Server } from 'net';
import { SinonSpy, SinonStub, spy, stub } from 'sinon';

import prepare = require('./lib/prepare');
import * as config from '../src/config';
import * as deviceState from '../src/device-state';
import Log from '../src/lib/supervisor-console';
import chai = require('./lib/chai-config');
import balenaAPI = require('./lib/mocked-balena-api');
import { schema } from '../src/config/schema';
import ConfigJsonConfigBackend from '../src/config/configJson';
import * as TargetState from '../src/device-state/target-state';
import { DeviceStatus } from '../src/types/state';
import * as CurrentState from '../src/device-state/current-state';
import * as ApiHelper from '../src/lib/api-helper';

import { TypedError } from 'typed-error';
import { DeviceNotFoundError } from '../src/lib/errors';

import { eventTrackSpy } from './lib/mocked-event-tracker';

const { expect } = chai;
let ApiBinder: typeof import('../src/api-binder');

class ExpectedError extends TypedError {}

const initModels = async (obj: Dictionary<any>, filename: string) => {
	await prepare();

	// @ts-expect-error setting read-only property
	config.configJsonBackend = new ConfigJsonConfigBackend(schema, filename);
	await config.generateRequiredFields();

	// @ts-expect-error using private properties
	config.configJsonBackend.cache = await config.configJsonBackend.read();
	await config.generateRequiredFields();

	obj.logger = {
		clearOutOfDateDBLogs: () => {
			/* noop */
		},
	} as any;

	ApiBinder = await import('../src/api-binder');
	await ApiBinder.initialized;
	obj.apiBinder = ApiBinder;

	await deviceState.initialized;
	obj.deviceState = deviceState;
};

const mockProvisioningOpts = {
	apiEndpoint: 'http://0.0.0.0:3000',
	uuid: 'abcd',
	deviceApiKey: 'averyvalidkey',
	provisioningApiKey: 'anotherveryvalidkey',
	apiTimeout: 30000,
};

describe('ApiBinder', () => {
	const defaultConfigBackend = config.configJsonBackend;
	let server: Server;

	before(async () => {
		delete require.cache[require.resolve('../src/api-binder')];

		spy(balenaAPI.balenaBackend!, 'registerHandler');
		server = balenaAPI.listen(3000);
	});

	after(() => {
		// @ts-expect-error setting read-only property
		balenaAPI.balenaBackend!.registerHandler.restore();
		try {
			server.close();
		} catch (error) {
			/* noop */
		}
	});

	// We do not support older OS versions anymore, so we only test this case
	describe('on an OS with deviceApiKey support', () => {
		const components: Dictionary<any> = {};

		before(async () => {
			await initModels(components, '/config-apibinder.json');
		});

		afterEach(() => {
			eventTrackSpy.resetHistory();
		});

		after(async () => {
			eventTrackSpy.restore();

			// @ts-expect-error setting read-only property
			config.configJsonBackend = defaultConfigBackend;
			await config.generateRequiredFields();
		});

		it('provisions a device', async () => {
			const opts = await config.get('provisioningOptions');
			await ApiHelper.provision(components.apiBinder.balenaApi, opts);

			expect(balenaAPI.balenaBackend!.registerHandler).to.be.calledOnce;
			expect(eventTrackSpy).to.be.called;
			expect(eventTrackSpy).to.be.calledWith('Device bootstrap success');

			// @ts-expect-error function does not exist on type
			balenaAPI.balenaBackend!.registerHandler.resetHistory();
		});

		it('exchanges keys if resource conflict when provisioning', async () => {
			// Get current config to extend
			const currentConfig = await config.get('provisioningOptions');

			// Stub config values so we have correct conditions
			const configStub = stub(config, 'get').resolves({
				...currentConfig,
				registered_at: null,
				provisioningApiKey: '123', // Previous test case deleted the provisioningApiKey so add one
				uuid: 'not-unique', // This UUID is used in mocked-balena-api as an existing registered UUID
			});

			// If api-binder reaches this function then tests pass
			// We throw an error so we don't have to keep stubbing
			const functionToReach = stub(
				ApiHelper,
				'exchangeKeyAndGetDeviceOrRegenerate',
			).throws(new ExpectedError());

			spy(Log, 'debug');

			try {
				const opts = await config.get('provisioningOptions');
				await ApiHelper.provision(components.apiBinder.balenaApi, opts);
			} catch (e) {
				// Check that the error thrown is from this test
				expect(e).to.be.instanceOf(ExpectedError);
			}

			expect(functionToReach.called).to.be.true;
			expect((Log.debug as SinonSpy).lastCall.lastArg).to.equal(
				'UUID already registered, trying a key exchange',
			);

			// Restore stubs
			configStub.restore();
			functionToReach.restore();
			(Log.debug as SinonStub).restore();
		});

		it('deletes the provisioning key', async () => {
			expect(await config.get('apiKey')).to.be.undefined;
		});

		it('sends the correct parameters when provisioning', async () => {
			const conf = JSON.parse(
				await fs.readFile('./test/data/config-apibinder.json', 'utf8'),
			);
			expect(balenaAPI.balenaBackend!.devices).to.deep.equal({
				'1': {
					id: 1,
					application: conf.applicationId,
					uuid: conf.uuid,
					device_type: conf.deviceType,
					api_key: conf.deviceApiKey,
				},
			});
		});
	});

	describe('fetchDevice', () => {
		const components: Dictionary<any> = {};
		before(() => {
			return initModels(components, '/config-apibinder.json');
		});
		after(async () => {
			// @ts-expect-error setting read-only property
			config.configJsonBackend = defaultConfigBackend;
			await config.generateRequiredFields();
		});

		it('gets a device by its uuid from the balena API', async () => {
			// Manually add a device to the mocked API
			balenaAPI.balenaBackend!.devices[3] = {
				id: 3,
				user: 'foo',
				application: 1337,
				uuid: 'abcd',
				device_type: 'intel-nuc',
				api_key: 'verysecure',
			};

			const device = await ApiHelper.fetchDevice(
				components.apiBinder.balenaApi,
				'abcd',
				'someApiKey',
				30000,
			);
			expect(device).to.deep.equal(balenaAPI.balenaBackend!.devices[3]);
		});
	});

	describe('exchangeKeyAndGetDevice', () => {
		const components: Dictionary<any> = {};
		before(() => {
			return initModels(components, '/config-apibinder.json');
		});
		after(async () => {
			// @ts-expect-error setting read-only property
			config.configJsonBackend = defaultConfigBackend;
			await config.generateRequiredFields();
		});

		it('returns the device if it can fetch it with the deviceApiKey', async () => {
			spy(balenaAPI.balenaBackend!, 'deviceKeyHandler');

			const fetchDeviceStub = stub(ApiHelper, 'fetchDevice');
			fetchDeviceStub.onCall(0).resolves({ id: 1 });

			const device = await ApiHelper.exchangeKeyAndGetDevice(
				components.apiBinder.balenaApi,
				mockProvisioningOpts,
			);

			expect(balenaAPI.balenaBackend!.deviceKeyHandler).to.not.be.called;
			expect(device).to.deep.equal({ id: 1 });
			expect(fetchDeviceStub).to.be.calledOnce;

			// @ts-expect-error function does not exist on type
			balenaAPI.balenaBackend.deviceKeyHandler.restore();
			fetchDeviceStub.restore();
		});

		it('throws if it cannot get the device with any of the keys', () => {
			spy(balenaAPI.balenaBackend!, 'deviceKeyHandler');
			const fetchDeviceStub = stub(ApiHelper, 'fetchDevice').throws(
				new DeviceNotFoundError(),
			);

			const promise = ApiHelper.exchangeKeyAndGetDevice(
				components.apiBinder.balenaApi,
				mockProvisioningOpts,
			);
			promise.catch(() => {
				/* noop */
			});

			return expect(promise).to.be.rejected.then(() => {
				expect(balenaAPI.balenaBackend!.deviceKeyHandler).to.not.be.called;
				expect(fetchDeviceStub).to.be.calledTwice;
				fetchDeviceStub.restore();
				// @ts-expect-error function does not exist on type
				balenaAPI.balenaBackend.deviceKeyHandler.restore();
			});
		});

		it('exchanges the key and returns the device if the provisioning key is valid', async () => {
			spy(balenaAPI.balenaBackend!, 'deviceKeyHandler');
			const fetchDeviceStub = stub(ApiHelper, 'fetchDevice');
			fetchDeviceStub.onCall(0).throws(new DeviceNotFoundError());
			fetchDeviceStub.onCall(1).returns(Promise.resolve({ id: 1 }));

			const device = await ApiHelper.exchangeKeyAndGetDevice(
				components.apiBinder.balenaApi,
				mockProvisioningOpts as any,
			);
			expect(balenaAPI.balenaBackend!.deviceKeyHandler).to.be.calledOnce;
			expect(device).to.deep.equal({ id: 1 });
			expect(fetchDeviceStub).to.be.calledTwice;
			fetchDeviceStub.restore();
			// @ts-expect-error function does not exist on type
			balenaAPI.balenaBackend.deviceKeyHandler.restore();
		});
	});

	describe('unmanaged mode', () => {
		const components: Dictionary<any> = {};
		before(() => {
			return initModels(components, '/config-apibinder-offline.json');
		});
		after(async () => {
			// @ts-expect-error setting read-only property
			config.configJsonBackend = defaultConfigBackend;
			await config.generateRequiredFields();
		});

		it('does not generate a key if the device is in unmanaged mode', async () => {
			const mode = await config.get('unmanaged');
			// Ensure offline mode is set
			expect(mode).to.equal(true);
			// Check that there is no deviceApiKey
			const conf = await config.getMany(['deviceApiKey', 'uuid']);
			expect(conf['deviceApiKey']).to.be.empty;
			expect(conf['uuid']).to.not.be.undefined;
		});

		describe('Minimal config unmanaged mode', () => {
			const components2: Dictionary<any> = {};
			before(() => {
				return initModels(components2, '/config-apibinder-offline2.json');
			});

			it('does not generate a key with the minimal config', async () => {
				const mode = await config.get('unmanaged');
				expect(mode).to.equal(true);
				const conf = await config.getMany(['deviceApiKey', 'uuid']);
				expect(conf['deviceApiKey']).to.be.empty;
				return expect(conf['uuid']).to.not.be.undefined;
			});
		});
	});

	describe('local mode', () => {
		const components: Dictionary<any> = {};

		before(() => {
			return initModels(components, '/config-apibinder.json');
		});

		after(async () => {
			// @ts-expect-error setting read-only property
			config.configJsonBackend = defaultConfigBackend;
			await config.generateRequiredFields();
		});

		const sampleState = {
			local: {
				ip_address: '192.168.1.42 192.168.1.99',
				api_port: 48484,
				api_secret:
					'20ffbd6e15aba827dca6381912d6aeb6c3a7a7c7206d4dfadf0d2f0a9e1136',
				os_version: 'balenaOS 2.32.0+rev4',
				os_variant: 'dev',
				supervisor_version: '9.16.3',
				provisioning_progress: null,
				provisioning_state: '',
				status: 'Idle',
				logs_channel: null,
				apps: {},
				is_on__commit: 'whatever',
			},
			dependent: { apps: {} },
		} as DeviceStatus;

		it('should strip applications data', () => {
			const result = CurrentState.stripDeviceStateInLocalMode(
				sampleState,
			) as Dictionary<any>;
			expect(result).to.not.have.property('dependent');

			const local = result['local'];
			expect(local).to.not.have.property('apps');
			expect(local).to.not.have.property('is_on__commit');
			expect(local).to.not.have.property('logs_channel');
		});
	});

	describe('healthchecks', () => {
		const components: Dictionary<any> = {};
		let configStub: SinonStub;
		let infoLobSpy: SinonSpy;
		let previousLastFetch: ReturnType<typeof process.hrtime>;

		before(async () => {
			await initModels(components, '/config-apibinder.json');
			previousLastFetch = TargetState.lastFetch;
		});

		after(async () => {
			// @ts-expect-error setting read-only property
			config.configJsonBackend = defaultConfigBackend;
			await config.generateRequiredFields();
		});

		beforeEach(() => {
			// This configStub will be modified in each test case so we can
			// create the exact conditions we want to for testing healthchecks
			configStub = stub(config, 'getMany');
			infoLobSpy = spy(Log, 'info');
		});

		afterEach(() => {
			configStub.restore();
			infoLobSpy.restore();
			(TargetState as any).lastFetch = previousLastFetch;
		});

		it('passes with correct conditions', async () => {
			// Set unmanaged to false so we check all values
			// The other values are stubbed to make it pass
			configStub.resolves({
				unmanaged: false,
				appUpdatePollInterval: 1000,
				connectivityCheckEnabled: false,
			});
			// Set lastFetch to now so it is within appUpdatePollInterval
			(TargetState as any).lastFetch = process.hrtime();
			expect(await components.apiBinder.healthcheck()).to.equal(true);
		});

		it('passes if unmanaged is true and exit early', async () => {
			// Setup failing conditions
			configStub.resolves({
				unmanaged: false,
				appUpdatePollInterval: null,
				connectivityCheckEnabled: false,
			});
			// Verify this causes healthcheck to fail
			expect(await components.apiBinder.healthcheck()).to.equal(false);
			// Do it again but set unmanaged to true
			configStub.resolves({
				unmanaged: true,
				appUpdatePollInterval: null,
				connectivityCheckEnabled: false,
			});
			expect(await components.apiBinder.healthcheck()).to.equal(true);
		});

		it('fails if appUpdatePollInterval not set in config and exit early', async () => {
			configStub.resolves({
				unmanaged: false,
				appUpdatePollInterval: null,
				connectivityCheckEnabled: false,
			});
			expect(await components.apiBinder.healthcheck()).to.equal(false);
			expect(Log.info).to.be.calledOnce;
			expect((Log.info as SinonSpy).lastCall?.lastArg).to.equal(
				'Healthcheck failure - Config value `appUpdatePollInterval` cannot be null',
			);
		});

		it("fails when hasn't checked target state within poll interval", async () => {
			configStub.resolves({
				unmanaged: false,
				appUpdatePollInterval: 1,
				connectivityCheckEnabled: false,
			});
			expect(await components.apiBinder.healthcheck()).to.equal(false);
			expect(Log.info).to.be.calledOnce;
			expect((Log.info as SinonSpy).lastCall?.lastArg).to.equal(
				'Healthcheck failure - Device has not fetched target state within appUpdatePollInterval limit',
			);
		});

		it('fails when stateReportHealthy is false', async () => {
			const currentState = await import('../src/device-state/current-state');

			configStub.resolves({
				unmanaged: false,
				appUpdatePollInterval: 1000,
				connectivityCheckEnabled: true,
			});

			// Set lastFetch to now so it is within appUpdatePollInterval
			(TargetState as any).lastFetch = process.hrtime();

			// Copy previous values to restore later
			const previousStateReportErrors = currentState.stateReportErrors;
			const previousDeviceStateConnected =
				// @ts-ignore
				components.deviceState.connected;

			// Set additional conditions not in configStub to cause a fail
			try {
				currentState.stateReportErrors = 4;
				components.deviceState.connected = true;

				expect(await components.apiBinder.healthcheck()).to.equal(false);

				expect(Log.info).to.be.calledOnce;
				expect((Log.info as SinonSpy).lastCall?.lastArg).to.equal(
					stripIndent`
					Healthcheck failure - At least ONE of the following conditions must be true:
						- No connectivityCheckEnabled   ? false
						- device state is disconnected  ? false
						- stateReportErrors less then 3 ? false`,
				);
			} finally {
				// Restore previous values
				currentState.stateReportErrors = previousStateReportErrors;
				components.deviceState.connected = previousDeviceStateConnected;
			}
		});
	});
});