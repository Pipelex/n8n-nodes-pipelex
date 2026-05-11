import {
	NodeConnectionTypes,
	NodeOperationError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

interface PipelexExecuteBody {
	inputs: Record<string, unknown>;
	pipe_code?: string;
	mthds_contents?: string[];
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
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Execute Pipelex pipelines',
		defaults: {
			name: 'Pipelex',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'piplexApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Pipeline',
						value: 'pipeline',
					},
				],
				default: 'pipeline',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['pipeline'],
					},
				},
				options: [
					{
						name: 'Execute',
						value: 'execute',
						description: 'Execute a pipeline and wait for the result',
						action: 'Execute a pipeline',
					},
				],
				default: 'execute',
			},
			{
				displayName: 'Pipe Code',
				name: 'pipeCode',
				type: 'string',
				default: '',
				placeholder: 'e.g., my-pipeline-code',
				description:
					'The code of the pipe to execute. Required unless an MTHDS Bundle is provided in Additional Fields.',
				displayOptions: {
					show: {
						resource: ['pipeline'],
						operation: ['execute'],
					},
				},
			},
			{
				displayName: 'Inputs',
				name: 'inputs',
				type: 'json',
				default: '{}',
				required: true,
				description:
					'The inputs for the pipeline. See <a href="https://docs.pipelex.com/pages/api/" target="_blank">Pipelex API docs</a> for the expected format.',
				displayOptions: {
					show: {
						resource: ['pipeline'],
						operation: ['execute'],
					},
				},
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: {
					show: {
						resource: ['pipeline'],
						operation: ['execute'],
					},
				},
				options: [
					{
						displayName: 'MTHDS Bundle',
						name: 'mthdsContent',
						type: 'string',
						typeOptions: {
							rows: 10,
						},
						default: '',
						placeholder: 'Enter your MTHDS bundle content here...',
						description:
							'The MTHDS bundle content (sent as mthds_contents). Provide this if you do not pass a Pipe Code.',
					},
					{
						displayName: 'Output Name',
						name: 'outputName',
						type: 'string',
						default: '',
						description: 'Optional name of the output variable',
					},
					{
						displayName: 'Output Multiplicity',
						name: 'outputMultiplicity',
						type: 'string',
						default: '',
						description: 'Optional output multiplicity',
					},
					{
						displayName: 'Dynamic Output Concept Code',
						name: 'dynamicOutputConceptCode',
						type: 'string',
						default: '',
						description: 'Optional dynamic output concept code',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('piplexApi');
		const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');

		for (let i = 0; i < items.length; i++) {
			try {
				const pipeCode = this.getNodeParameter('pipeCode', i, '') as string;
				const inputsString = this.getNodeParameter('inputs', i) as string;
				const additionalFields = this.getNodeParameter('additionalFields', i, {}) as {
					mthdsContent?: string;
					outputName?: string;
					outputMultiplicity?: string;
					dynamicOutputConceptCode?: string;
				};

				const mthdsContent = additionalFields.mthdsContent ?? '';

				if (!pipeCode && !mthdsContent) {
					throw new NodeOperationError(
						this.getNode(),
						'At least one of "Pipe Code" or "MTHDS Bundle" must be provided',
						{ itemIndex: i },
					);
				}

				let inputs: Record<string, unknown>;
				try {
					inputs = JSON.parse(inputsString);
				} catch (error) {
					throw new NodeOperationError(
						this.getNode(),
						`Invalid JSON in inputs field: ${(error as Error).message}`,
						{ itemIndex: i },
					);
				}

				const body: PipelexExecuteBody = {
					inputs,
				};

				if (pipeCode) body.pipe_code = pipeCode;
				if (mthdsContent) body.mthds_contents = [mthdsContent];
				if (additionalFields.outputName) body.output_name = additionalFields.outputName;
				if (additionalFields.outputMultiplicity)
					body.output_multiplicity = additionalFields.outputMultiplicity;
				if (additionalFields.dynamicOutputConceptCode)
					body.dynamic_output_concept_code = additionalFields.dynamicOutputConceptCode;

				const url = `${baseUrl}/api/v1/pipeline/execute`;

				const response = await this.helpers.httpRequestWithAuthentication.call(
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
							error: (error as Error).message,
						},
						pairedItem: { item: i },
					});
					continue;
				}
				if (error instanceof NodeOperationError) {
					throw error;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
