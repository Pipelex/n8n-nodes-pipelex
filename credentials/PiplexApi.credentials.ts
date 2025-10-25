import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class PiplexApi implements ICredentialType {
	name = 'piplexApi';
	displayName = 'Pipelex Bearer Token';
	documentationUrl = 'https://docs.pipelex.com/pages/api/';
	properties: INodeProperties[] = [
		{
			displayName: 'Bearer Token',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description: 'Your Pipelex API Bearer Token (will be sent as Authorization: Bearer YOUR_TOKEN)',
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
			baseURL: 'http://127.0.0.1:8081/api/v1',
			url: '/health',
			method: 'GET',
		},
	};
}

