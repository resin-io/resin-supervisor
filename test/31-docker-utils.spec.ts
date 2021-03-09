import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { testWithData } from './lib/mocked-dockerode';
import * as dockerUtils from '../src/lib/docker-utils';
import log from '../src/lib/supervisor-console';
import * as sampleDeltaImages from './data/delta-image-data.json';

describe('Docker Utils', () => {
	describe('Supervisor Address', () => {
		// setup some fake data...
		const networks = {
			supervisor0: {
				IPAM: {
					Config: [
						{
							Gateway: '10.0.105.1',
							Subnet: '10.0.105.0/16',
						},
					],
				},
			},
		};

		// test using existing data...
		it('should return the correct gateway address for supervisor0', async () => {
			await testWithData({ networks }, async () => {
				const gateway = await dockerUtils.getNetworkGateway('supervisor0');
				expect(gateway).to.equal('10.0.105.1');
			});
		});

		it('should return the correct gateway address for host', async () => {
			await testWithData({ networks }, async () => {
				const gateway = await dockerUtils.getNetworkGateway('host');
				expect(gateway).to.equal('127.0.0.1');
			});
		});
	});

	describe('Image Environment', () => {
		const images = {
			['test-image']: {
				Config: {
					Env: ['TEST_VAR_1=1234', 'TEST_VAR_2=5678'],
				},
			},
		};

		// test using existing data...
		it('should return the correct image environment', async () => {
			await testWithData({ images }, async () => {
				const obj = await dockerUtils.getImageEnv('test-image');
				expect(obj).to.have.property('TEST_VAR_1').equal('1234');
				expect(obj).to.have.property('TEST_VAR_2').equal('5678');
			});
		});
	});

	describe('Delta utils', () => {
		let logDebugStub: SinonStub;
		let getRegAndNameStub: SinonStub;
		let dockerProgressPullStub: SinonStub;

		const testArgs = {
			// It really doesn't matter what imgDest is. We're simply storing it
			// to check that it's used in the appropriate calls.
			imgDest: sampleDeltaImages.V2.inspect.Config.Image,
			deltaOpts: {
				deltaSource: 'registry2.balena-cloud.com/v2/12345@sha256:789',
				uuid: 'abc',
				currentApiKey: '123',
				apiEndpoint: 'https://api.balena-cloud.com',
				deltaEndpoint: 'https://delta.balena-cloud.com',
				delta: true,
				deltaRequestTimeout: 30000,
				deltaApplyTimeout: 0,
				deltaRetryCount: 30,
				deltaRetryInterval: 10000,
				deltaVersion: 2,
				deltaSourceId: sampleDeltaImages.V2.inspect.Config.Image,
			},
			onProgress: () => {
				/* noop */
			},
			serviceName: 'test_service',
			registryAndName: {
				registry: 'a',
				imageName: 'b',
				tagName: 'c',
				digest: 'd',
			},
			dockerOpts: {
				authconfig: {
					username: 'd_abc', // d_${uuid}
					password: '123', // currentApiKey
					serverAddress: 'b', // registry
				},
			},
		};

		before(() => {
			logDebugStub = stub(log, 'debug');

			getRegAndNameStub = stub(
				dockerUtils.dockerToolbelt,
				'getRegistryAndName',
			).resolves(testArgs.registryAndName);

			dockerProgressPullStub = stub(
				dockerUtils.dockerProgress,
				'pull',
			).resolves();
		});

		after(() => {
			logDebugStub.restore();
			getRegAndNameStub.restore();
			dockerProgressPullStub.restore();
		});

		afterEach(() => {
			logDebugStub.resetHistory();
			getRegAndNameStub.resetHistory();
			dockerProgressPullStub.resetHistory();
		});

		it('should revert to image fetch for unsupported delta version', async () => {
			await testWithData(
				{ images: sampleDeltaImages.V2.dockerode },
				async () => {
					await dockerUtils.fetchDeltaWithProgress(
						testArgs.imgDest,
						testArgs.deltaOpts,
						testArgs.onProgress,
						testArgs.serviceName,
					);

					expect(logDebugStub).calledWith(
						`delta([${testArgs.serviceName}] ${testArgs.deltaOpts.deltaSource}): ` +
							`Unsupported delta version: ${testArgs.deltaOpts.deltaVersion}. Falling back to regular pull`,
					);

					// Fallback to dockerUtils.fetchImageWithProgress
					expect(getRegAndNameStub).calledWith(testArgs.imgDest);
					expect(dockerProgressPullStub).calledWith(
						testArgs.imgDest,
						testArgs.onProgress,
					);
				},
			);
		});

		it('should revert to image fetch when trying to apply v3 delta on top of v2 delta', async () => {
			// Set delta to v3, but keep deltaSourceId at V2.
			// Mock dockerode with both V2 & V3 delta image so that
			// dockerUtils.isV2DeltaImage can find the V2 image to get
			// the size of.
			testArgs.deltaOpts.deltaVersion = 3;

			await testWithData(
				{
					images: {
						...sampleDeltaImages.V2.dockerode,
						...sampleDeltaImages.V3.dockerode,
					},
				},
				async () => {
					await dockerUtils.fetchDeltaWithProgress(
						testArgs.imgDest,
						testArgs.deltaOpts,
						testArgs.onProgress,
						testArgs.serviceName,
					);

					expect(logDebugStub).calledWith(
						`delta([${testArgs.serviceName}] ${testArgs.deltaOpts.deltaSource}): ` +
							'Cannot create a delta from V2 to V3, falling back to regular pull',
					);

					// Fallback to dockerUtils.fetchImageWithProgress
					expect(getRegAndNameStub).calledWith(testArgs.imgDest);
					expect(dockerProgressPullStub).calledWith(
						testArgs.imgDest,
						testArgs.onProgress,
					);
				},
			);
		});
	});
});
