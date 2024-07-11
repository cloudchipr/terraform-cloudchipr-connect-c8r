// Code is not ready, there are console logs for troubleshooting

const https = require("https"),
  urlUtil = require("url"),
  requestMethodMap = { CREATE: "patch", Create: "patch", Update: "patch", Delete: "delete" },
  AWS = require("aws-sdk");
class ResponseError extends Error {
  constructor(e) {
    super(
      "The HTTP response failed with status code " +
        e.statusCode +
        ": " +
        e.statusMessage
    ),
      (this.result = e);
  }
}
const send = (e, t) =>
    new Promise((o, s) => {
      const r = Object.assign({}, e);
      if (r.url) {
        const e = urlUtil.parse(r.url);
        (r.path = e.path), (r.hostname = e.host), delete r.url;
      }
      (r.port = 443),
        console.debug(
          "send: opening request to host=" + r.hostname + " path=" + r.path
        );
      const n = https.request(r, (e) => {
        let t = Buffer.from([]);
        e.on("data", (e) => {
          t = Buffer.concat([t, e]);
        }),
          e.on("end", () => {
            console.debug(
              "send: finished receiving response statusCode=" +
                e.statusCode +
                ": " +
                e.statusMessage
            );
            const r = {
              body: t.length > 0 ? t.toString("utf8") : null,
              statusCode: e.statusCode,
              statusMessage: e.statusMessage,
              headers: Object.assign({}, e.headers),
            };
            e.statusCode >= 200 && e.statusCode < 300
              ? o(r)
              : s(new ResponseError(r));
          }),
          e.on("error", (e) => {
            console.error("send: https response error", e), s(e);
          });
      });
      n.on("error", (e) => {
        console.error("send: https request error", e), s(e);
      }),
        t &&
          n.write(t, () => {
            console.debug("send: written request body");
          }),
        n.end(),
        n.on("close", () => {
          console.debug("send: request closed");
        });
    }),
  respondToCloudformationAndTerminate = (e, t, o) => {
    const s = JSON.stringify(o);
    return send(
      {
        url: e.ResponseURL,
        method: "PUT",
        headers: { "content-type": "", "content-length": s.length },
      },
      s
    );
  },
  createCostUsageReport = async (bucketName, reportName, iamRole, accountId) => {
      const costUsageReport = new AWS.CUR();
      const prefix = 'reports/';

      // Checking if report exists
        const describeReportsParams = {};
        const reportDefinitions = [];
        let response = await costUsageReport.describeReportDefinitions(describeReportsParams).promise();

        reportDefinitions.push(...response.ReportDefinitions);

        while (response.NextToken) {
            params.NextToken = response.NextToken;

            response = await costUsageReport.describeReportDefinitions(describeReportsParams).promise();
            reportDefinitions.push(...response.ReportDefinitions);
        }

        const reportDefinition = reportDefinitions.find(rd => rd.ReportName === reportName);
        if (reportDefinition) {
            console.log(`The report definition '${reportName}' exists.`);
            return true
        }

      const reportParams = {
          ReportDefinition: {
              AdditionalSchemaElements: [
                  'RESOURCES'
              ],
              S3Bucket: bucketName,
              S3Prefix: prefix,
              S3Region: process.env.AWS_REGION,
              TimeUnit: 'DAILY',
              Format: 'textORcsv',
              Compression: 'GZIP',
              ReportName: reportName,
              ReportVersioning: 'OVERWRITE_REPORT'
          }
      };

      console.log(reportParams)

      try {
          await createBucket(bucketName, iamRole, accountId)
          const result = await costUsageReport.putReportDefinition(reportParams).promise();
          console.log("cost and usage create result: " + result);
      } catch (err) {
          console.log("Failed to create cost and usage report: " + err);
      }
  },
  createBucket = async (bucketName, iamRole, accountId) => {
      const s3 = new AWS.S3();

      const createBucketParams = {
          Bucket: bucketName
      };

      const policy = {
          Version: '2008-10-17',
          Id: 'Policy1335892530063',
          Statement: [
              {
                  Sid: 'Stmt1335892150622',
                  Effect: 'Allow',
                  Principal: {
                      Service: 'billingreports.amazonaws.com'
                  },
                  Action: [
                      's3:GetBucketAcl',
                      's3:GetBucketPolicy'
                  ],
                  Resource: 'arn:aws:s3:::' + bucketName,
                  Condition: {
                      StringEquals: {
                          'aws:SourceArn': 'arn:aws:cur:us-east-1:' + accountId + ':definition/*',
                          'aws:SourceAccount': accountId
                      }
                  }
              },
              {
                  Sid: 'Stmt1335892526596',
                  Effect: 'Allow',
                  Principal: {
                      Service: 'billingreports.amazonaws.com'
                  },
                  Action: [
                      's3:PutObject'
                  ],
                  Resource: 'arn:aws:s3:::' + bucketName + '/*',
                  Condition: {
                      StringEquals: {
                          'aws:SourceArn': 'arn:aws:cur:us-east-1:' + accountId + ':definition/*',
                          'aws:SourceAccount': accountId
                      }
                  }
              },
              {
                  Sid: 'AllowRoleAccessToBucket',
                  Effect: 'Allow',
                  Principal: {
                      AWS: iamRole
                  },
                  Action: 's3:GetObject',
                  Resource: 'arn:aws:s3:::' + bucketName + '/*',
              }
          ]
      };

      const policyParams = {
          Bucket: bucketName,
          Policy: JSON.stringify(policy)
      }

      if (process.env.AWS_REGION !== "us-east-1") {
          createBucketParams.CreateBucketConfiguration = {
              LocationConstraint: process.env.AWS_REGION
          }
      }

      try {
          console.log("Trying to create bucket", createBucketParams);
          const result = await s3.createBucket(createBucketParams).promise();
          console.log("S3 bucket create result: " + result);

          console.log("Trying to apply policy");
          const policyResult = await s3.putBucketPolicy(policyParams).promise();
          console.log("S3 bucket policy apply result: " + policyResult);
      } catch (err) {
          console.log("Failed to create bucket or apply policy", err);
      }
  },
  handler = async (e, t) => {
    AWS.config.update({
      region: "us-east-1",
      credentials: new AWS.EnvironmentCredentials("AWS"),
    });
    let accountName = "",
      organisationName = "",
      masterAccountId = Math.random().toString(36).substring(2, 15); // some random id, temp: will be removed

    try {
      const t = new AWS.Organizations({ apiVersion: "2016-11-28" }),
        n = await t.describeOrganization({}).promise();

      if (e.ResourceProperties.AccountId === n.Organization.MasterAccountId) {
        accountName = (
          await t
            .describeAccount({ AccountId: e.ResourceProperties.AccountId })
            .promise()
        ).Account.Name;
      } else {
        const e = new AWS.IAM({ apiVersion: "2010-05-08" });
        accountName = (await e.listAccountAliases({ MaxItems: 1 }).promise())
          .AccountAliases[0];
      }

      organisationName = n.Organization.Id;
      masterAccountId = n.Organization.MasterAccountId;
    } catch (err) {
      console.info("The user is not member of any organisation");
    }

    try {
        console.info("Tries to create cost and useage report");
        await createCostUsageReport(
            e.ResourceProperties.BucketName,
            e.ResourceProperties.ReportName,
            e.ResourceProperties.IAMRole,
            e.ResourceProperties.AccountId
        )
    } catch (err) {
        console.info("failed to create cost and usage report, reason: " + err.message);
    }

    const n = {
        provider_confirmation_token: e.ResourceProperties.ConfirmationToken,
        provider_account_id: e.ResourceProperties.AccountId,
        provider_organisation_id: organisationName,
        provider_root_account_id: masterAccountId,
        provider_account_name: accountName,
        provider_region: process.env.AWS_REGION,
      },
      a = JSON.stringify(n),
      i = {
        StackId: e.StackId,
        RequestId: e.RequestId,
        LogicalResourceId: e.LogicalResourceId,
        PhysicalResourceId: t.logStreamName,
        Data: { message: "" },
      },
      c = requestMethodMap[e.RequestType];

    console.log(n);

    try {
      if ("delete" === c)
        return (
          (i.Status = "SUCCESS"),
          (i.Data.message = "Cloudchipr Role deleted successfully"),
          (i.Result = await respondToCloudformationAndTerminate(e, 0, i)),
          i
        );

      var responseMessage = ""
      if (e.ResourceProperties.ExecutionType !== undefined && e.ResourceProperties.ExecutionType !== "UPDATE") {
            const o = await send(
                {
                    method: c,
                    url: process.env.C8R_API_ENDPOINT + e.ResourceProperties.C8RUniqueId,
                    headers: {
                        "content-length": a.length,
                        "content-type": "application/json",
                        "User-Agent": "c8r/1.0.0"
                    },
                },
                a
            );
            console.log(o)
          responseMessage = o.body
      } else {
          responseMessage = "No need to request for account confirmation, executionsType: " + e.ResourceProperties.ExecutionType
      }

      return (
        (i.Status = "SUCCESS"),
        (i.Data.message = "Cloudchipr Role created successfully"),
        console.info(
          "RoleCreateCallback: " + c + " response from webapp",
            responseMessage
        ),
        i
      );
    } catch (t) {
      return (
        (i.Status = "FAILED"),
        (i.Data.message = "Error encountered during Role creation."),
        console.error(
          "RoleCreateCallback: Error response from " + c + " request to webapp",
          t,
          t.result
        ),
        i
      );
    }
  };
module.exports.handler = handler;


