process.env.DOCKER_HOST = 'unix:///your/dockerode/mocks/are/not/working';

import * as dockerode from 'dockerode';
import { Stream } from 'stream';
import _ = require('lodash');
import { TypedError } from 'typed-error';

export class NotFoundError extends TypedError {
	public statusCode: number;
	constructor() {
		super();
		this.statusCode = 404;
	}
}

const overrides: Dictionary<(...args: any[]) => Resolvable<any>> = {};

interface Action {
	name: string;
	parameters: Dictionary<any>;
}

export let actions: Action[] = [];

export function resetHistory() {
	actions = [];
}

function addAction(name: string, parameters: Dictionary<any>) {
	actions.push({
		name,
		parameters,
	});
}

type DockerodeFunction = keyof dockerode;
for (const fn of Object.getOwnPropertyNames(dockerode.prototype)) {
	if (
		fn !== 'constructor' &&
		typeof (dockerode.prototype as any)[fn] === 'function'
	) {
		(dockerode.prototype as any)[fn] = function (...args: any[]) {
			console.log(`🐳  Calling ${fn}...`);
			if (overrides[fn] != null) {
				return overrides[fn](args);
			}

			/* Return promise */
			return Promise.resolve([]);
		};
	}
}

// default overrides needed to startup...
registerOverride('listImages', async () => []);
registerOverride(
	'getEvents',
	async () =>
		new Stream.Readable({
			read: () => {
				return _.noop();
			},
		}),
);

export function registerOverride<
	T extends DockerodeFunction,
	P extends Parameters<dockerode[T]>,
	R extends ReturnType<dockerode[T]>
>(name: T, fn: (...args: P) => R) {
	console.log(`Overriding ${name}...`);
	overrides[name] = fn;
}

export function restoreOverride<T extends DockerodeFunction>(name: T) {
	if (overrides.hasOwnProperty(name)) {
		delete overrides[name];
	}
}

export interface TestData {
	networks: Dictionary<any>;
	images: Dictionary<any>;
	containers: Dictionary<any>;
}

function createMockedDockerode(data: TestData) {
	const mockedDockerode = dockerode.prototype;
	mockedDockerode.createContainer = async (
		options: dockerode.ContainerCreateOptions,
	) => {
		addAction('createContainer', { options });
		return {
			start: async () => {
				addAction('start', {});
			},
		} as dockerode.Container;
	};
	mockedDockerode.getContainer = (id: string) => {
		addAction('getContainer', { id });
		return {
			start: async () => {
				addAction('start', {});
				data.containers = data.containers.map((c: any) => {
					if (c.containerId === id) {
						c.status = 'Installing';
					}
					return c;
				});
			},
			stop: async () => {
				addAction('stop', {});
				data.containers = data.containers.map((c: any) => {
					if (c.containerId === id) {
						c.status = 'Stopping';
					}
					return c;
				});
			},
			remove: async () => {
				addAction('remove', {});
				data.containers = data.containers.map((c: any) => {
					if (c.containerId === id) {
						c.status = 'removing';
					}
					return c;
				});
			},
		} as dockerode.Container;
	};
	mockedDockerode.getNetwork = (id: string) => {
		addAction('getNetwork', { id });
		return {
			inspect: async () => {
				addAction('inspect', {});
				return data.networks[id];
			},
		} as dockerode.Network;
	};

	mockedDockerode.getImage = (name: string) => {
		addAction('getImage', { name });
		return {
			inspect: async () => {
				addAction('inspect', {});
				return data.images[name];
			},
			remove: async () => {
				addAction('remove', {});
				data.images = _.reject(data.images, {
					name,
				});
			},
		} as dockerode.Image;
	};

	return mockedDockerode;
}

type Prototype = Dictionary<(...args: any[]) => any>;
function clonePrototype(prototype: Prototype): Prototype {
	const clone: Prototype = {};
	Object.getOwnPropertyNames(prototype).forEach((fn) => {
		if (fn !== 'constructor' && _.isFunction(prototype[fn])) {
			clone[fn] = prototype[fn];
		}
	});

	return clone;
}

function assignPrototype(target: Prototype, source: Prototype) {
	Object.keys(source).forEach((fn) => {
		target[fn] = source[fn];
	});
}

export async function testWithData(
	data: Partial<TestData>,
	test: () => Promise<any>,
) {
	const mockedData: TestData = {
		...{
			networks: {},
			images: {},
			containers: {},
		},
		...data,
	};

	// grab the original prototype...
	const basePrototype = clonePrototype(dockerode.prototype);

	// @ts-expect-error setting a RO property
	dockerode.prototype = createMockedDockerode(mockedData);

	try {
		// run the test...
		await test();
	} finally {
		// reset the original prototype...
		assignPrototype(dockerode.prototype, basePrototype);
	}
}
