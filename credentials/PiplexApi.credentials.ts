import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class PiplexApi implements ICredentialType {
	name = 'piplexApi';
	displayName = 'Pipelex Bearer Token API';
	documentationUrl = 'https://docs.pipelex.com/pages/api/';
	icon: Icon = 'file:icons/pipelex.svg';
	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.pipelex.com',
			required: true,
			placeholder: 'https://api.pipelex.com',
			description: 'The base URL of your Pipelex API server',
		},
		{
			displayName: 'Bearer Token',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description: 'The API key to the Pipelex API. Create one at https://app.pipelex.com/',
			placeholder: 'your-bearer-token-here',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			// `/me` is the canonical "is this token live?" endpoint — accessible to any
			// authenticated user via JWT or API key, no role gate. `/runner/v1/api_version`
			// (the previous test path) sits behind the admin-only `/runner/v1/*` route gate,
			// so non-admin users with perfectly valid tokens see the credential test
			// fail with a 403 "Forbidden". `/me` returns 200 + the user's profile.
			url: '/me',
			method: 'GET',
		},
	};
}
