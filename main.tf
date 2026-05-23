resource "aws_iam_role" "cloudchipr_stack_iam_role" {
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
  path               = "/"
  name               = local.iam_role_name
}

resource "aws_iam_role_policy" "c8r_stack" {
  name   = "CloudchiprStack"
  role   = aws_iam_role.cloudchipr_stack_iam_role.id
  policy = var.access_level == "read" ? data.aws_iam_policy_document.CloudchiprStack_read.json : data.aws_iam_policy_document.CloudchiprStack_read-write.json
}

resource "aws_iam_role_policy" "c8r_stack_self_inspect" {
  name   = "SelfInspect"
  role   = aws_iam_role.cloudchipr_stack_iam_role.id
  policy = data.aws_iam_policy_document.SelfInspect.json
}

resource "aws_iam_role" "basic_lambda_execution_role" {
  assume_role_policy = data.aws_iam_policy_document.assume_role_execution.json
  path               = "/"
  name               = local.lambda_function_name
}

resource "aws_iam_role_policy" "c8r_stack_lambda_basic" {
  name   = "BasicLambdaExecutionPolicy"
  role   = aws_iam_role.basic_lambda_execution_role.id
  policy = data.aws_iam_policy_document.execution_role_policy.json
}
resource "aws_iam_role_policy" "c8r_stack_lambda_cost" {
  name   = "CostOptimizationHubRecommendationPolicy"
  role   = aws_iam_role.basic_lambda_execution_role.id
  policy = data.aws_iam_policy_document.cost_optimization_hub_policy.json
}

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/lambda/index.js"
  output_path = "${path.module}/lambda/lambda_function.zip"
}

resource "aws_lambda_function" "cloudchipr_app_callback_lambda_function" {
  depends_on = [aws_iam_role.basic_lambda_execution_role]

  function_name = local.lambda_function_name
  description   = "Report Cloudchipr Role ARN to Cloudchipr"
  filename      = data.archive_file.lambda.output_path
  handler       = "index.handler"
  role          = aws_iam_role.basic_lambda_execution_role.arn
  runtime       = "nodejs24.x"
  timeout       = 30
  environment {
    variables = {
      C8R_API_ENDPOINT = var.C8R_API_ENDPOINT
      IS_TERRAFORM     = true
    }
  }
}

resource "aws_lambda_invocation" "lambda_execution_role_invoke" {
  depends_on    = [aws_lambda_function.cloudchipr_app_callback_lambda_function]
  function_name = aws_lambda_function.cloudchipr_app_callback_lambda_function.function_name

  input = jsonencode({
    "RequestType" : local.execution_type,
    "ResponseURL" : local.response_url,
    "ResourceProperties" : {
      "ServiceToken" : aws_lambda_function.cloudchipr_app_callback_lambda_function.arn,
      "RoleArn" : aws_iam_role.cloudchipr_stack_iam_role.arn,
      "AccountId" : local.account_id,
      "C8RUniqueId" : local.c8r_unique_id,
      "ConfirmationToken" : local.confirmation_token,
      "ReportName" : local.report_name,
      "BucketName" : local.bucket_name,
      "ExecutionType" : local.execution_type,
      "IAMRole" : local.iam_role_arn,
      "UniqueRequestId" : local.unique_request_id
      "DataExportCUR2Name" : local.data_export_cur2_name
      "DataExportFOCUSName" : local.data_export_focus_name
      "DataExportCostOptimizationRecommendationName" : local.data_export_opthub_report
      "DataExportCarbonEmissionsName" : local.data_export_carbon_report
      "SubAccountsAssumeRoleName" : local.sub_account_role
    }
  })
}
