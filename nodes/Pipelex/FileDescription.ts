import type { INodeProperties } from 'n8n-workflow';

/**
 * The node's **File** resource: the organization's files in Pipelex, the same
 * list the app's Files page shows — members' uploads, the build assistant's test
 * files and the final outputs of runs. Two operations read it:
 *
 * - **Get Many** lists the files, newest first, with the platform's filters, one
 *   output item per file (`GET /v1/files`, paged until the limit or the end).
 * - **Download** fetches one file's bytes as n8n binary data, found by its name
 *   or by its ID, so a workflow can feed a team file to a run's Binary Inputs or
 *   to another node (`POST /v1/files/links`, then the presigned link).
 *
 * The behaviour lives in `FileFunctions.ts`; this file is only what the editor
 * shows. It is spread into the node's properties beside the **Run** resource's
 * operations, whose values it never reuses, so the node's `execute` can dispatch
 * on the resource and each operation's fields show on its own value alone.
 */

/** The value of the node's `resource` parameter that selects the operations below. */
export const FILE_RESOURCE = 'file';

/** The File resource's operation values. */
export const FILE_OPERATION = {
	download: 'download',
	getAll: 'getAll',
} as const;

/** How Download finds its file. */
export const DOWNLOAD_BY = {
	name: 'name',
	id: 'id',
} as const;

/** What Download does when several files share the name it was given. */
export const WHEN_SEVERAL_MATCH = {
	newest: 'newest',
	fail: 'fail',
} as const;

// The properties below spell their defaults as literals, because the n8n lint
// reads a default only when it is one; `test/Files.test.ts` pins each literal to
// the constant the code reads.

/** The binary field a downloaded file lands in unless the author names another. */
export const DEFAULT_DOWNLOAD_BINARY_PROPERTY = 'data';

/** The page of Get Many when Return All is off — n8n's convention for a limit. */
export const DEFAULT_FILE_LIMIT = 50;

/** The File resource's own Operation selector, shown only when the resource is File. */
export const fileOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: {
				resource: [FILE_RESOURCE],
			},
		},
		options: [
			{
				name: 'Download',
				value: FILE_OPERATION.download,
				action: 'Download a file',
				description:
					"Download one of your organization's files, found by its name or its ID, as binary data — to give it to a run's Binary Inputs or to another node",
			},
			{
				name: 'Get Many',
				value: FILE_OPERATION.getAll,
				action: 'Get many files',
				description:
					"List your organization's files, newest first, one item per file, with its uri, name, type, size and origin",
			},
		],
		default: 'download',
	},
];

const showOnDownload = {
	resource: [FILE_RESOURCE],
	operation: [FILE_OPERATION.download],
};

const showOnGetAll = {
	resource: [FILE_RESOURCE],
	operation: [FILE_OPERATION.getAll],
};

/** The fields of the File resource's operations, each shown on its own operation alone. */
export const fileFields: INodeProperties[] = [
	// ── Download ──────────────────────────────────────────────────────────────
	{
		displayName: 'Find File By',
		name: 'downloadBy',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Name',
				value: DOWNLOAD_BY.name,
				description: 'The name your team sees in Pipelex, such as March invoice.pdf',
			},
			{
				name: 'ID',
				value: DOWNLOAD_BY.id,
				description: 'The file ID, such as the file_id of an item from Get Many',
			},
		],
		default: 'name',
		displayOptions: {
			show: showOnDownload,
		},
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g., March invoice.pdf',
		description:
			"The name of the file in your organization's files, extension included. Names are compared ignoring case.",
		displayOptions: {
			show: {
				...showOnDownload,
				downloadBy: [DOWNLOAD_BY.name],
			},
		},
	},
	{
		displayName: 'If Several Files Have This Name',
		name: 'whenSeveralMatch',
		type: 'options',
		options: [
			{
				name: 'Use the Newest',
				value: WHEN_SEVERAL_MATCH.newest,
				description: 'Download the file created last',
			},
			{
				name: 'Fail',
				value: WHEN_SEVERAL_MATCH.fail,
				description: 'Fail the item, naming two of the files, so you can download one by its ID',
			},
		],
		default: 'newest',
		description: 'What to do when more than one file carries the name',
		displayOptions: {
			show: {
				...showOnDownload,
				downloadBy: [DOWNLOAD_BY.name],
			},
		},
	},
	{
		displayName: 'File ID',
		name: 'fileId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g., fl_0199a3c4e5f6',
		description: 'The ID of the file, its file_id. Map the file_id of an item from Get Many here.',
		displayOptions: {
			show: {
				...showOnDownload,
				downloadBy: [DOWNLOAD_BY.id],
			},
		},
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		description: 'The name of the output binary field to put the file in',
		displayOptions: {
			show: showOnDownload,
		},
	},

	// ── Get Many ──────────────────────────────────────────────────────────────
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: {
			show: showOnGetAll,
		},
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: {
			minValue: 1,
		},
		default: 50,
		description: 'Max number of results to return',
		displayOptions: {
			show: {
				...showOnGetAll,
				returnAll: [false],
			},
		},
	},
	// The platform's own filters, by their wire names in `FileFunctions.readFileListFilters`.
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: {
			show: showOnGetAll,
		},
		options: [
			{
				displayName: 'Created By',
				name: 'createdBy',
				type: 'string',
				default: 'me',
				description:
					"Only the files of one member, by their user ID, or me for the files of the credential's user: their uploads and the outputs of the runs they started",
			},
			{
				displayName: 'Created From',
				name: 'createdFrom',
				type: 'dateTime',
				default: '',
				description:
					"Only the files created at or after this date and time. A value without a time zone is read in the workflow's time zone.",
			},
			{
				displayName: 'Created To',
				name: 'createdTo',
				type: 'dateTime',
				default: '',
				description:
					"Only the files created at or before this date and time. A value without a time zone is read in the workflow's time zone.",
			},
			{
				displayName: 'Format',
				name: 'formats',
				type: 'string',
				default: '',
				placeholder: 'e.g., pdf, image',
				description:
					'Only the files of these formats, separated by commas: pdf, docx, image, html, and the other format keys Pipelex gives files',
			},
			{
				displayName: 'Kind',
				name: 'kind',
				type: 'options',
				options: [
					{
						name: 'Generated',
						value: 'generated',
						description: 'Made by a run',
					},
					{
						name: 'Test',
						value: 'test',
						description: 'Made by the build assistant as a test input',
					},
					{
						name: 'Uploaded',
						value: 'uploaded',
						description: 'Uploaded by a member, through the app, an SDK, n8n or an agent',
					},
				],
				default: 'uploaded',
				description: 'Only the files of this kind',
			},
			{
				displayName: 'Media Type',
				name: 'mediaTypes',
				type: 'string',
				default: '',
				placeholder: 'e.g., image/png, image/jpeg',
				description: 'Only the files of these MIME types, separated by commas',
			},
			{
				displayName: 'Method ID',
				name: 'methodId',
				type: 'string',
				default: '',
				placeholder: 'e.g., mt_abc123',
				description:
					"Only the files of this stored method, by its bare ID: the files its runs and examples took or made",
			},
			{
				displayName: 'Run ID',
				name: 'runId',
				type: 'string',
				default: '',
				description:
					"Only the files of this run, by its pipeline_run_id: its final outputs and the files given inline as its inputs, in the order of their addresses rather than newest first",
			},
			{
				displayName: 'Search',
				name: 'q',
				type: 'string',
				default: '',
				placeholder: 'e.g., invoice',
				description: "Text to find in the file's name or original name, ignoring case",
			},
		],
	},
];
