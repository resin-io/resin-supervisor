import { expect } from 'chai';
import { stub } from 'sinon';

import * as dockerUtils from '../src/lib/docker-utils';
import * as sampleDeltaImages from './data/delta-image-data.json';

describe('Deltas', () => {
	it('should correctly detect a V2 delta', async () => {
		const imageStub = stub(dockerUtils.docker, 'getImage').returns({
			inspect: () => {
				return Promise.resolve(sampleDeltaImages.V2.inspect);
			},
		} as any);

		expect(await dockerUtils.isV2DeltaImage('test')).to.be.true;
		expect(imageStub.callCount).to.equal(1);
		imageStub.restore();
	});
});
