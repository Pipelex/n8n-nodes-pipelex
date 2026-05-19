import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

interface PipelexExecuteBody {
	inputs: Record<string, unknown>;
	pipe_code?: string;
	mthds_contents?: string[];
	output_name?: string;
	output_multiplicity?: string;
	// API field name is `dynamic_output_concept_ref` (matches the upstream
	// `mthds.client.pipeline.PipelineRequest` model). The FastAPI route
	// silently ignores unrecognized keys, so a typo here = a silent no-op
	// override.
	dynamic_output_concept_ref?: string;
}

export class Pipelex implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Pipelex',
		name: 'pipelex',
		icon: 'file:pipelex.png',
		group: ['transform'],
		version: 1,
		// Subtitle previously read $parameter.operation + $parameter.resource, but
		// this node only does one thing ("Execute Pipeline"). When more operations
		// land (e.g., /pipeline/start, run-status lookups), reintroduce a Resource
		// + Operation switcher and a dynamic subtitle.
		subtitle: 'Execute Pipeline',
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
			// Field order: MTHDS Bundles (the big payload) → Inputs → Pipe Code →
			// optional overrides. Pipe Code lives below Inputs because in the most
			// common flow the user pastes/edits a bundle, fills the inputs, then
			// picks which pipe inside the bundle to run. Pipe Code and MTHDS Bundles
			// are mutually-exclusive but one is REQUIRED; XOR enforced at runtime.
			{
				displayName: 'MTHDS Bundles',
				name: 'mthdsContents',
				type: 'string',
				typeOptions: {
					// API accepts `list[str]`. `multipleValues: true` renders a "+ Add
					// Bundle" button so users can pass multiple bundles in one request.
					// Each entry is still a multi-line textarea via `rows: 10`.
					multipleValues: true,
					multipleValueButtonText: 'Add Bundle',
					rows: 10,
				},
				default: [],
				placeholder: 'Enter MTHDS bundle content...',
				description:
					'One or more MTHDS bundle contents (sent as mthds_contents). Provide at least one OR a Pipe Code.',
			},
			{
				displayName: 'Inputs',
				name: 'inputs',
				type: 'json',
				default: '{}',
				description:
					'The inputs for the pipeline. Defaults to {} server-side if omitted. See <a href="https://docs.pipelex.com/pages/api/" target="_blank">Pipelex API docs</a> for the expected format.',
			},
			{
				displayName: 'Pipe Code',
				name: 'pipeCode',
				type: 'string',
				default: '',
				placeholder: 'e.g., my-pipeline-code',
				description:
					'The code of the pipe to execute. Provide this OR MTHDS Bundles (one is required).',
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
				displayName: 'Dynamic Output Concept Ref',
				name: 'dynamicOutputConceptRef',
				type: 'string',
				default: '',
				description:
					'Optional override for the dynamic output concept ref (sent as dynamic_output_concept_ref)',
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
				const mthdsContentsRaw = this.getNodeParameter('mthdsContents', i, []) as unknown;
				const inputsString = this.getNodeParameter('inputs', i) as string;
				const outputName = this.getNodeParameter('outputName', i, '') as string;
				const outputMultiplicity = this.getNodeParameter('outputMultiplicity', i, '') as string;
				const dynamicOutputConceptRef = this.getNodeParameter(
					'dynamicOutputConceptRef',
					i,
					'',
				) as string;

				// `multipleValues: true` on a string field yields a `string[]`. Filter
				// out empty entries — the n8n UI persists a default empty string when
				// users click "Add Bundle" without typing anything.
				const mthdsContents: string[] = Array.isArray(mthdsContentsRaw)
					? (mthdsContentsRaw as string[]).filter((entry) => typeof entry === 'string' && entry.length > 0)
					: [];

				if (!pipeCode && mthdsContents.length === 0) {
					throw new NodeOperationError(
						this.getNode(),
						'At least one of "Pipe Code" or "MTHDS Bundles" must be provided',
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
				if (mthdsContents.length > 0) body.mthds_contents = mthdsContents;
				if (outputName) body.output_name = outputName;
				if (outputMultiplicity) body.output_multiplicity = outputMultiplicity;
				if (dynamicOutputConceptRef) body.dynamic_output_concept_ref = dynamicOutputConceptRef;

				const url = `${baseUrl}/runner/v1/pipeline/execute`;

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
				if (error instanceof NodeOperationError || error instanceof NodeApiError) {
					throw error;
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
