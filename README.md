# AWS Account Connection Module for Cloudchipr

## About

This module is designed to connect your AWS Organization/Account to Cloudchipr. It creates IAM Roles with the necessary permissions and a Lambda function for setting up Cloudchipr and starting to save.

## Usage Example

### Read and Write Access
```hcl
module "cloudchipr" {
    source = "PATH_TO_OUR_PUBLIC_REPO_WHERE_THE_MODULE_IS_PLACED"
    access_level = "read_write"
    data         = "00885,ea06c9aed56468d36,2d5a9e3e-d94a-488c-b903-b2826d,67037b4-8b9d095e55c2_d78KpAIS8tOwg6JCjV5WAfun,CloudchiprAccessRole-ea73a27660227fccee5d5cd5e7,CloudchiprCrossAccountRole-p5xNQ9PIA,CloudchiprBasicLambdaExecutionRole-p5xN3lA,CloudchiprAppCallback-p5xN3lwlfaVNB4XQ9PIA,cost-and-usage-report-p5xQ9PIA.csv,cloudchipr-p5xn3lwlfavnb4xq9pia,Create,2d5a9e3e-d94a-488c-b903-b2880cb8726d"
}
```

### Read Only Access
```hcl
module "cloudchipr" {
    source = "PATH_TO_OUR_PUBLIC_REPO_WHERE_THE_MODULE_IS_PLACED"
    access_level = "read"
    data         = "00885,ea06c9aed56468d36,2d5a9e3e-d94a-488c-b903-b2826d,67037b4-8b9d095e55c2_d78KpAIS8tOwg6JCjV5WAfun,CloudchiprAccessRole-ea73a27660227fccee5d5cd5e7,CloudchiprCrossAccountRole-p5xNQ9PIA,CloudchiprBasicLambdaExecutionRole-p5xN3lA,CloudchiprAppCallback-p5xN3lwlfaVNB4XQ9PIA,cost-and-usage-report-p5xQ9PIA.csv,cloudchipr-p5xn3lwlfavnb4xq9pia,Create,2d5a9e3e-d94a-488c-b903-b2880cb8726d"
}
```

#### The data field information is available at app.cloudchipr.com. Press on `Add Account` from the `AWS Live Usage and Management` page and select `Terraform`.

## License
Cloudchipr License. See [LICENSE](https://github.com/cloudchipr/api-bff/terraform/LICENSE) for more information.  
