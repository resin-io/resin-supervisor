import { expect } from 'chai';
import { stub, SinonStub } from 'sinon';
import { testWithData } from './lib/mocked-dockerode';
import * as dockerUtils from '../src/lib/docker-utils';
import log from '../src/lib/supervisor-console';

describe('Delta utils', () => {
	let logDebugStub: SinonStub;
	let getRegAndNameStub: SinonStub;
	let dockerProgressPullStub: SinonStub;

	const testArgs = {
		// It really doesn't matter what imgDest is. We're simply storing it
		// to check that it's used in the appropriate calls.
		imgDest:
			'sha256:b24946093df7157727b20934d11a7287359d8de42d8a80030f51f46a73d645ec',
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
			deltaSourceId:
				'sha256:b24946093df7157727b20934d11a7287359d8de42d8a80030f51f46a73d645ec',
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
		rsyncDeltaImage: {
			'sha256:b24946093df7157727b20934d11a7287359d8de42d8a80030f51f46a73d645ec': {
				Containers: -1,
				Created: 1575541251,
				Id:
					'sha256:b24946093df7157727b20934d11a7287359d8de42d8a80030f51f46a73d645ec',
				Labels: {
					'io.resin.architecture': 'amd64',
					'io.resin.device-type': 'intel-nuc',
				},
				ParentId: '',
				RepoDigests: null,
				RepoTags: null,
				SharedSize: -1,
				Size: 17,
				VirtualSize: 17,
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

	it('should revert to image fetch for unsupported delta version', async () => {
		await testWithData({ images: testArgs.rsyncDeltaImage }, async () => {
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
		});
	});
});
