import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

interface PipelexExecuteBody {
	inputs: Record<string, unknown>;
	pipe_code?: string;
	plx_content?: string;
	output_name?: string;
	output_multiplicity?: string;
	dynamic_output_concept_code?: string;
}

export class Pipelex implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Pipelex',
		name: 'pipelex',
		icon: 'file:pipelex.png',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Execute Pipelex pipelines',
		defaults: {
			name: 'Pipelex',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'piplexApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Base URL',
				name: 'baseUrl',
				type: 'string',
				default: 'http://localhost:8081',
				required: true,
				placeholder: 'http://localhost:8081',
				description: 'The base URL of your Pipelex API server',
			},
			{
				displayName: 'Pipe Code (pipe_code)',
				name: 'pipeCode',
				type: 'string',
				default: '',
				required: false,
				placeholder: 'e.g., my-pipeline-code',
				description: 'API: pipe_code - The pipeline code to execute (optional if Pipelex Bundle is provided)',
			},
			{
				displayName: 'Pipelex Bundle (plx_content)',
				name: 'plxContent',
				type: 'string',
				typeOptions: {
					rows: 10,
				},
				default: '',
				required: false,
				placeholder: 'Enter your Pipelex code here...',
				description: 'API: plx_content - The Pipelex bundle content (optional if Pipe Code is provided). At least one of Pipe Code or Pipelex Bundle must be provided.',
			},
			{
				displayName: 'inputs',
				name: 'inputs',
				type: 'json',
				default: '{}',
				required: true,
				description: 'API: inputs - The inputs for the pipeline. Learn more about the inputs format <a href="https://docs.pipelex.com/pages/api/" target="_blank">Pipelex doc</a>',
			},
			{
				displayName: 'output_name',
				name: 'outputName',
				type: 'string',
				default: '',
				description: 'API: output_name - Optional output name',
			},
			{
				displayName: 'output_multiplicity',
				name: 'outputMultiplicity',
				type: 'string',
				default: '',
				description: 'API: output_multiplicity - Optional output multiplicity',
			},
			{
				displayName: 'dynamic_output_concept_code',
				name: 'dynamicOutputConceptCode',
				type: 'string',
				default: '',
				description: 'API: dynamic_output_concept_code - Optional dynamic output concept code',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const baseUrl = this.getNodeParameter('baseUrl', i) as string;
				const pipeCode = this.getNodeParameter('pipeCode', i, '') as string;
				const plxContent = this.getNodeParameter('plxContent', i, '') as string;
				const inputsString = this.getNodeParameter('inputs', i) as string;
				const outputName = this.getNodeParameter('outputName', i, null) as string | null;
				const outputMultiplicity = this.getNodeParameter('outputMultiplicity', i, null) as string | null;
				const dynamicOutputConceptCode = this.getNodeParameter('dynamicOutputConceptCode', i, null) as string | null;

				if (!pipeCode && !plxContent) {
					throw new Error('At least one of "Pipe Code" or "Pipelex Bundle" must be provided');
				}

				let inputs;
				try {
					inputs = JSON.parse(inputsString);
				} catch (error) {
					throw new Error(`Invalid JSON in inputs field: ${error.message}`);
				}

			const body: PipelexExecuteBody = {
				inputs,
			};
			
			if (pipeCode) body.pipe_code = pipeCode;
			if (plxContent) body.plx_content = plxContent;
			if (outputName) body.output_name = outputName;
			if (outputMultiplicity) body.output_multiplicity = outputMultiplicity;
			if (dynamicOutputConceptCode) body.dynamic_output_concept_code = dynamicOutputConceptCode;

			const url = `${baseUrl.replace(/\/$/, '')}/api/v1/pipeline/execute`;

				const response = await this.helpers.requestWithAuthentication.call(
					this,
					'piplexApi',
					{
						method: 'POST',
						url,
						body,
						json: true,
					},
				);

				returnData.push({
					json: response,
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: error.message,
						},
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}

