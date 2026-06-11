import type { ICredentialTestRequest, ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

/**
 * NOTE — no `authenticate` block, on purpose. n8n injects a "Custom API Call"
 * entry into the Operation dropdown of every node whose credential declares a
 * generic `authenticate` (core: `LoadNodesAndCredentials.injectCustomApiCallOptions`
 * → `supportsProxyAuth`, pushing `CUSTOM_API_CALL_NAME`). That raw-HTTP escape
 * hatch makes no sense for this node's four curated operations, so the
 * Authorization header is built manually instead (see `buildApiConnection` in
 * `nodes/Pipelex/GenericFunctions.ts`) and the credential `test` request
 * carries its own header — the `test` block alone does NOT trigger the
 * injection, so credential verification keeps working.
 */
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

	// The test request authenticates itself (no `authenticate` block to lean
	// on — see the class comment). `$credentials` expressions resolve here the
	// same way the `baseURL` expression already does.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/auth/verify',
			method: 'GET',
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};
}
