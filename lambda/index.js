const https = require("https");
const urlUtil = require("url");

const {
    S3Client,
    CreateBucketCommand,
    HeadBucketCommand,
    PutBucketPolicyCommand
} = require("@aws-sdk/client-s3");
const {
    BCMDataExportsClient,
    ListExportsCommand,
    CreateExportCommand
} = require("@aws-sdk/client-bcm-data-exports");
const {
    CostOptimizationHubClient,
    ListEnrollmentStatusesCommand,
    UpdateEnrollmentStatusCommand
} = require("@aws-sdk/client-cost-optimization-hub");
const {
    CostAndUsageReportServiceClient,
    DescribeReportDefinitionsCommand,
    PutReportDefinitionCommand
} = require("@aws-sdk/client-cost-and-usage-report-service");
const {fromEnv} = require("@aws-sdk/credential-providers");
const {
    IAMClient,
    ListAccountAliasesCommand,
    GetRoleCommand,
    CreateServiceLinkedRoleCommand,
    NoSuchEntityException
} = require("@aws-sdk/client-iam");
const {
    OrganizationsClient,
    DescribeOrganizationCommand,
    DescribeAccountCommand
} = require("@aws-sdk/client-organizations");

const s3 = new S3Client({credentials: fromEnv()});
const bcm = new BCMDataExportsClient({region: "us-east-1", credentials: fromEnv()});
const cur = new CostAndUsageReportServiceClient({region: "us-east-1", credentials: fromEnv()});
const costOptimizationHub = new CostOptimizationHubClient({ region: "us-east-1", credentials: fromEnv() });
const iam = new IAMClient({region: "us-east-1", credentials: fromEnv()});
const organizations = new OrganizationsClient({region: "us-east-1", credentials: fromEnv()});

const requestMethodMap = {Create: "patch", Update: "patch", Delete: "delete"};

const errorsMap = new Map();

class ResponseError extends Error {
    constructor(e) {
        super(
            `The HTTP response failed with status code ${e.statusCode}: ${e.statusMessage}`
        );
        this.result = e;
    }
}

const sendHttpsRequest = (options, body) =>
    new Promise((resolve, reject) => {
        const reqOptions = {...options};
        if (reqOptions.url) {
            const parsedUrl = urlUtil.parse(reqOptions.url);
            reqOptions.path = parsedUrl.path;
            reqOptions.hostname = parsedUrl.host;
            delete reqOptions.url;
        }
        reqOptions.port = 443;

        console.debug(`send: opening request to host=${reqOptions.hostname} path=${reqOptions.path}`);

        const req = https.request(reqOptions, (res) => {
            let responseBody = Buffer.from([]);
            res.on("data", (chunk) => {
                responseBody = Buffer.concat([responseBody, chunk]);
            });
            res.on("end", () => {
                console.debug(`send: finished receiving response statusCode=${res.statusCode}: ${res.statusMessage}`);
                const response = {
                    body: responseBody.length > 0 ? responseBody.toString("utf8") : null,
                    statusCode: res.statusCode,
                    statusMessage: res.statusMessage,
                    headers: {...res.headers}
                };
                res.statusCode >= 200 && res.statusCode < 300
                    ? resolve(response)
                    : reject(new ResponseError(response));
            });
            res.on("error", (e) => {
                console.error("send: https response error", e);
                reject(e);
            });
        });

        req.on("error", (e) => {
            console.error("send: https request error", e);
            reject(e);
        });

        if (body) {
            req.write(body, () => {
                console.debug("send: written request body");
            });
        }
        req.end();
        req.on("close", () => {
            console.debug("send: request closed");
        });
    });

const respondToCloudFormation = (event, response) => {
    // Exit early if the function is running in a Terraform environment
    if (process.env.IS_TERRAFORM) {
        return;
    }

    const body = JSON.stringify(response);
    return sendHttpsRequest(
        {
            url: event.ResponseURL,
            method: "PUT",
            headers: {"content-type": "", "content-length": body.length}
        },
        body
    );
};

const createS3Bucket = async (bucketName) => {
    try {
        const params = {
            Bucket: bucketName,
            BucketEncryption: {
                ServerSideEncryptionConfiguration: [
                    {
                        ServerSideEncryptionByDefault: {
                            SSEAlgorithm: "AES256"
                        }
                    }
                ]
            },
            PublicAccessBlockConfiguration: {
                IgnorePublicAcls: true,
                RestrictPublicBuckets: true
            }
        };

        if (process.env.AWS_REGION !== "us-east-1") {
            params.CreateBucketConfiguration = {
                LocationConstraint: process.env.AWS_REGION
            }
        }

        await s3.send(new CreateBucketCommand(params));
        console.log(`Bucket ${bucketName} created successfully.`);
    } catch (err) {
        console.error("Error creating bucket:", err);
        errorsMap.set("createS3Bucket", "Error creating bucket: " + err.message)
        throw err;
    }
};

const setS3BucketPolicy = async (bucketName, iamRole, accountId) => {
    try {
        const policy = {
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Principal: {
                        Service: ["billingreports.amazonaws.com", "bcm-data-exports.amazonaws.com"]
                    },
                    Action: ["s3:GetBucketAcl", "s3:PutObject", "s3:GetBucketPolicy"],
                    Resource: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
                    Condition: {
                        StringLike: {
                            "aws:SourceArn": [
                                `arn:aws:cur:us-east-1:${accountId}:definition/*`,
                                `arn:aws:bcm-data-exports:us-east-1:${accountId}:export/*`
                            ],
                            "aws:SourceAccount": accountId
                        }
                    }
                },
                {
                    Sid: "AllowRoleAccessToBucket",
                    Effect: "Allow",
                    Principal: {
                        AWS: `${iamRole}`
                    },
                    Action: "s3:GetObject",
                    Resource: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`]
                }
            ]
        };

        const params = {
            Bucket: bucketName,
            Policy: JSON.stringify(policy)
        };

        await s3.send(new PutBucketPolicyCommand(params));
        console.log(`Bucket policy set for ${bucketName}.`);
    } catch (err) {
        console.error("Error setting bucket policy:", err);
        errorsMap.set("setS3BucketPolicy", "Error setting bucket policy: " + err.message)
        throw err;
    }
};

const createCostUsageReport = async (bucketName, reportName) => {
    const prefix = 'reports/';

    // Checking if report exists
    const describeReportsParams = {};
    const reportDefinitions = [];
    let response = await cur.send(new DescribeReportDefinitionsCommand(describeReportsParams));

    reportDefinitions.push(...response.ReportDefinitions);

    while (response.NextToken) {
        describeReportsParams.NextToken = response.NextToken;

        response = await cur.send(new DescribeReportDefinitionsCommand(describeReportsParams));
        reportDefinitions.push(...response.ReportDefinitions);
    }

    const reportDefinition = reportDefinitions.find(rd => rd.ReportName === reportName);
    if (reportDefinition) {
        console.log(`The report definition '${reportName}' exists.`);
        return true;
    }

    const reportParams = {
        ReportDefinition: {
            ReportName: reportName,
            TimeUnit: "DAILY",
            Format: "textORcsv",
            Compression: "GZIP",
            AdditionalSchemaElements: ["RESOURCES"],
            S3Bucket: bucketName,
            S3Prefix: prefix,
            S3Region: process.env.AWS_REGION,
            ReportVersioning: "OVERWRITE_REPORT"
        }
    };

    console.log(reportParams);

    try {
        const result = await cur.send(new PutReportDefinitionCommand(reportParams));
        console.log("Cost and usage report created:", result);
    } catch (err) {
        console.error("Failed to create cost and usage report:", err);
        errorsMap.set("createCostUsageReport", "Failed to create cost and usage report: " + err.message)
    }
};

const createServiceLinkedRoleForBCM = async () => {
    try {
        await iam.send(new GetRoleCommand({RoleName: 'AWSServiceRoleForBCMDataExports'}));
        console.log('Service-linked role AWSServiceRoleForBCMDataExports already exists.');
    } catch (error) {
        if (error.name instanceof NoSuchEntityException || error.message.includes('cannot be found')) {
            const createRoleParams = {
                AWSServiceName: 'bcm-data-exports.amazonaws.com',
                Description: 'Role required by BCM Data Exports to access account resources.'
            };
            await iam.send(new CreateServiceLinkedRoleCommand(createRoleParams));
            console.log('Service-linked role AWSServiceRoleForBCMDataExports created.');
        } else {
            console.error(`Failed to create Service-linked role AWSServiceRoleForBCMDataExports: ${error.message}`);
            errorsMap.set("createServiceLinkedRoleForBCM", "Failed to create Service-linked role AWSServiceRoleForBCMDataExports:" + error.message)
            throw error;
        }
    }
};

const checkAndEnableCostOptimizationHub = async (isRoot) => {
    try {
        // Check if Cost Optimization Hub is enabled
        const listEnrollmentStatusesCommand = new ListEnrollmentStatusesCommand({});
        const statusResponse = await costOptimizationHub.send(listEnrollmentStatusesCommand);

        const accountStatus = statusResponse.items.find(status => status.AccountId === process.env.AWS_ACCOUNT_ID);
        if (accountStatus && accountStatus.Status === 'Active') {
            console.log('Cost Optimization Hub is already enabled.');
            return;
        }

        console.log('Cost Optimization Hub is not enabled. Enabling now...');
        // Enable Cost Optimization Hub
        const updateEnrollmentStatusCommand = new UpdateEnrollmentStatusCommand({
            status: "Active",
            includeMemberAccounts: isRoot
        });
        await costOptimizationHub.send(updateEnrollmentStatusCommand);

        console.log('Cost Optimization Hub has been enabled.');
    } catch (error) {
        console.error('Error checking or enabling Cost Optimization Hub:', error);
        errorsMap.set("checkAndEnableCostOptimizationHub", "Error checking or enabling Cost Optimization Hub: " + error.message)
        throw error;
    }
};

const createBcmDataExport = async (bucketName, exportName, queryStatement, tableConfigurations) => {
    const maxRetries = 5;
    const retryDelay = 4000; // 4 seconds delay between retries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const listExportsCommandInput = {};
            const { Exports } = await bcm.send(new ListExportsCommand(listExportsCommandInput));
            const exportExists = Exports.some(exp => exp.ExportName === exportName);

            if (exportExists) {
                console.log(`BCM data export '${exportName}' for bucket ${bucketName} already exists.`);
                return; // No need to proceed further if the export already exists
            } else {
                const createExportParams = {
                    Export: {
                        Name: exportName,
                        DataQuery: {
                            QueryStatement: queryStatement,
                            TableConfigurations: tableConfigurations
                        },
                        DestinationConfigurations: {
                            S3Destination: {
                                S3Bucket: bucketName,
                                S3Region: "us-east-1",
                                S3Prefix: "reports",
                                S3OutputConfigurations: {
                                    Compression: "PARQUET",
                                    Format: "PARQUET",
                                    OutputType: "CUSTOM",
                                    Overwrite: "OVERWRITE_REPORT"
                                }
                            }
                        },
                        RefreshCadence: {
                            Frequency: "SYNCHRONOUS"
                        }
                    }
                };

                await bcm.send(new CreateExportCommand(createExportParams));
                console.log(`BCM data export '${exportName}' created for bucket ${bucketName}.`);
                return; // Successful creation, exit the loop
            }
        } catch (err) {
            if (attempt < maxRetries) {
                console.log(`BCM data export create attempt ${attempt} failed. Retrying in ${retryDelay / 1000} seconds...`);
                await new Promise(res => setTimeout(res, retryDelay)); // Delay before retrying
            } else {
                console.log("Error creating BCM data export after multiple attempts:", err);
                errorsMap.set("createBcmDataExport", "Error creating BCM data export after multiple attempts: " + err.message)
                throw err; // Rethrow the error after max retries
            }
        }
    }
};

const createFocusExport = async (bucketName, exportName) => {
    await createBcmDataExport(
        bucketName,
        exportName,
        "SELECT AvailabilityZone, BilledCost, BillingAccountId, BillingAccountName, BillingCurrency, BillingPeriodEnd, BillingPeriodStart, ChargeCategory, ChargeClass, ChargeDescription, ChargeFrequency, ChargePeriodEnd, ChargePeriodStart, CommitmentDiscountCategory, CommitmentDiscountId, CommitmentDiscountName, CommitmentDiscountStatus, CommitmentDiscountType, ConsumedQuantity, ConsumedUnit, ContractedCost, ContractedUnitPrice, EffectiveCost, InvoiceIssuerName, ListCost, ListUnitPrice, PricingCategory, PricingQuantity, PricingUnit, ProviderName, PublisherName, RegionId, RegionName, ResourceId, ResourceName, ResourceType, ServiceCategory, ServiceName, SkuId, SkuPriceId, SubAccountId, SubAccountName, Tags, x_CostCategories, x_Discounts, x_Operation, x_ServiceCode, x_UsageType FROM FOCUS_1_0_AWS_PREVIEW",
        {FOCUS_1_0_AWS_PREVIEW: {}}
    );
};

const createCur2Export = async (bucketName, exportName) => {
    await createBcmDataExport(
        bucketName,
        exportName,
        "SELECT bill_bill_type, bill_billing_entity, bill_billing_period_end_date, bill_billing_period_start_date, bill_invoice_id, bill_invoicing_entity, bill_payer_account_id, bill_payer_account_name, cost_category, discount, discount_bundled_discount, discount_total_discount, identity_line_item_id, identity_time_interval, line_item_availability_zone, line_item_blended_cost, line_item_blended_rate, line_item_currency_code, line_item_legal_entity, line_item_line_item_description, line_item_line_item_type, line_item_net_unblended_cost, line_item_net_unblended_rate, line_item_normalization_factor, line_item_normalized_usage_amount, line_item_operation, line_item_product_code, line_item_resource_id, line_item_tax_type, line_item_unblended_cost, line_item_unblended_rate, line_item_usage_account_id, line_item_usage_account_name, line_item_usage_amount, line_item_usage_end_date, line_item_usage_start_date, line_item_usage_type, pricing_currency, pricing_lease_contract_length, pricing_offering_class, pricing_public_on_demand_cost, pricing_public_on_demand_rate, pricing_purchase_option, pricing_rate_code, pricing_rate_id, pricing_term, pricing_unit, product, product_comment, product_fee_code, product_fee_description, product_from_location, product_from_location_type, product_from_region_code, product_instance_family, product_instance_type, product_instancesku, product_location, product_location_type, product_operation, product_pricing_unit, product_product_family, product_region_code, product_servicecode, product_sku, product_to_location, product_to_location_type, product_to_region_code, product_usagetype, reservation_amortized_upfront_cost_for_usage, reservation_amortized_upfront_fee_for_billing_period, reservation_availability_zone, reservation_effective_cost, reservation_end_time, reservation_modification_status, reservation_net_amortized_upfront_cost_for_usage, reservation_net_amortized_upfront_fee_for_billing_period, reservation_net_effective_cost, reservation_net_recurring_fee_for_usage, reservation_net_unused_amortized_upfront_fee_for_billing_period, reservation_net_unused_recurring_fee, reservation_net_upfront_value, reservation_normalized_units_per_reservation, reservation_number_of_reservations, reservation_recurring_fee_for_usage, reservation_reservation_a_r_n, reservation_start_time, reservation_subscription_id, reservation_total_reserved_normalized_units, reservation_total_reserved_units, reservation_units_per_reservation, reservation_unused_amortized_upfront_fee_for_billing_period, reservation_unused_normalized_unit_quantity, reservation_unused_quantity, reservation_unused_recurring_fee, reservation_upfront_value, resource_tags, savings_plan_amortized_upfront_commitment_for_billing_period, savings_plan_end_time, savings_plan_instance_type_family, savings_plan_net_amortized_upfront_commitment_for_billing_period, savings_plan_net_recurring_commitment_for_billing_period, savings_plan_net_savings_plan_effective_cost, savings_plan_offering_type, savings_plan_payment_option, savings_plan_purchase_term, savings_plan_recurring_commitment_for_billing_period, savings_plan_region, savings_plan_savings_plan_a_r_n, savings_plan_savings_plan_effective_cost, savings_plan_savings_plan_rate, savings_plan_start_time, savings_plan_total_commitment_to_date, savings_plan_used_commitment, split_line_item_actual_usage, split_line_item_net_split_cost, split_line_item_net_unused_cost, split_line_item_parent_resource_id, split_line_item_public_on_demand_split_cost, split_line_item_public_on_demand_unused_cost, split_line_item_reserved_usage, split_line_item_split_cost, split_line_item_split_usage, split_line_item_split_usage_ratio, split_line_item_unused_cost FROM COST_AND_USAGE_REPORT",
        {
            COST_AND_USAGE_REPORT: {
                INCLUDE_RESOURCES: "TRUE",
                INCLUDE_SPLIT_COST_ALLOCATION_DATA: "TRUE",
                TIME_GRANULARITY: "DAILY"
            }
        }
    );
};

const createCostOptimizationRecommendationExport = async (bucketName, exportName) => {
    await createBcmDataExport(
        bucketName,
        exportName,
        "SELECT account_id, action_type, currency_code, current_resource_details, current_resource_summary, current_resource_type, estimated_monthly_cost_after_discount, estimated_monthly_cost_before_discount, estimated_monthly_savings_after_discount, estimated_monthly_savings_before_discount, estimated_savings_percentage_after_discount, estimated_savings_percentage_before_discount, implementation_effort, last_refresh_timestamp, recommendation_id, recommendation_lookback_period_in_days, recommendation_source, recommended_resource_details, recommended_resource_summary, recommended_resource_type, region, resource_arn, restart_needed, rollback_possible, tags FROM COST_OPTIMIZATION_RECOMMENDATIONS",
        {
            COST_OPTIMIZATION_RECOMMENDATIONS: {
                INCLUDE_ALL_RECOMMENDATIONS: "TRUE",
                FILTER: "{}"
            }
        }
    );
};

const handler = async (event, context) => {
    let accountName = "";
    let organizationName = "";
    let masterAccountId = "";

    try {
        const describeOrgResponse = await organizations.send(new DescribeOrganizationCommand({}));
        const organization = describeOrgResponse.Organization;

        if (event.ResourceProperties.AccountId === organization.MasterAccountId) {
            const describeAccountResponse = await organizations.send(new DescribeAccountCommand({AccountId: event.ResourceProperties.AccountId}));
            accountName = describeAccountResponse.Account.Name;
        } else {
            const listAccountAliasesResponse = await iam.send(new ListAccountAliasesCommand({MaxItems: 1}));
            accountName = listAccountAliasesResponse.AccountAliases[0];
        }

        organizationName = organization.Id;
        masterAccountId = organization.MasterAccountId;
    } catch (err) {
        console.info("The user is not a member of any organization.");
    }

    try {
        const bucketName = event.ResourceProperties.BucketName;
        const legacyCURReportName = event.ResourceProperties.ReportName;
        const dataExportCUR2Name = event.ResourceProperties.DataExportCUR2Name;
        const dataExportFOCUSName = event.ResourceProperties.DataExportFOCUSName;
        const dataExportCostOptimizationRecommendationName = event.ResourceProperties.DataExportCostOptimizationRecommendationName;
        const createdIamRole = event.ResourceProperties.IAMRole;
        const currentAccountId = event.ResourceProperties.AccountId;
        const isRoot = event.ResourceProperties.AccountId === masterAccountId;

        console.log("Properties: ")
        console.log(event.ResourceProperties)
        console.log(`Is root account: ${isRoot}`)

        try {
            await s3.send(new HeadBucketCommand({Bucket: bucketName}));
            console.log(`Bucket ${bucketName} already exists.`);
        } catch (err) {
            if (err.name === "NotFound") {
                await createS3Bucket(bucketName);
            } else {
                console.error("Error checking bucket:", err);
                throw err;
            }
        }

        await setS3BucketPolicy(bucketName, createdIamRole, currentAccountId);

        await createCostUsageReport(bucketName, legacyCURReportName);
        await createCur2Export(bucketName, dataExportCUR2Name);
        await createFocusExport(bucketName, dataExportFOCUSName);
        await createServiceLinkedRoleForBCM();
        await checkAndEnableCostOptimizationHub(isRoot);
        await createCostOptimizationRecommendationExport(bucketName, dataExportCostOptimizationRecommendationName);
    } catch (err) {
        console.error("Failed to create data exports, reason:", err.message);
        errorsMap.set("handler", "Failed to create data exports, reason: " + err.message)
    }

    const responseData = {
        provider_confirmation_token: event.ResourceProperties.ConfirmationToken,
        provider_account_id: event.ResourceProperties.AccountId,
        provider_organisation_id: organizationName,
        provider_root_account_id: masterAccountId,
        provider_account_name: accountName,
        provider_region: process.env.AWS_REGION,
        sub_accounts_assume_role_name: event.ResourceProperties.SubAccountsAssumeRoleName,
        errors: JSON.stringify(Object.fromEntries(errorsMap))
    };

    const cloudFormationResponse = {
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
        PhysicalResourceId: context.logStreamName,
        Data: {message: ""}
    };

    const method = requestMethodMap[event.RequestType];

    try {
        if (method === "delete") {
            cloudFormationResponse.Status = "SUCCESS";
            cloudFormationResponse.Data.message = "Cloudchipr Role deleted successfully";
            await respondToCloudFormation(event, cloudFormationResponse);
            return cloudFormationResponse;
        }

        let responseMessage = "";
        if (event.ResourceProperties.ExecutionType && event.ResourceProperties.ExecutionType !== "UPDATE") {
            const apiResponse = await sendHttpsRequest(
                {
                    method: method,
                    url: `${process.env.C8R_API_ENDPOINT}${event.ResourceProperties.C8RUniqueId}`,
                    headers: {
                        "content-length": JSON.stringify(responseData).length,
                        "content-type": "application/json",
                        "User-Agent": "c8r/1.0.0"
                    }
                },
                JSON.stringify(responseData)
            );
            responseMessage = apiResponse.body;
        } else {
            responseMessage = `No need to request for account confirmation, ExecutionType: ${event.ResourceProperties.ExecutionType}`;
        }

        cloudFormationResponse.Status = "SUCCESS";
        cloudFormationResponse.Data.message = "Cloudchipr Role created successfully";
        console.info("RoleCreateCallback:", method, "response from webapp", responseMessage);
        await respondToCloudFormation(event, cloudFormationResponse);
        return cloudFormationResponse;
    } catch (err) {
        cloudFormationResponse.Status = "FAILED";
        cloudFormationResponse.Data.message = "Error encountered during Role creation.";
        console.error("RoleCreateCallback: Error response from", method, "request to webapp", err, err.result);
        await respondToCloudFormation(event, cloudFormationResponse);
        return cloudFormationResponse;
    }
};

module.exports.handler = handler;
