import type { APIGatewayProxyEventQueryStringParameters } from "aws-lambda";
import { parse } from "qs";

interface KeyValue {
  [key: string]: unknown | undefined | string | string[] | KeyValue | KeyValue[];
}

export function extractNestedQueryStringParameters(
  params: APIGatewayProxyEventQueryStringParameters | null,
): KeyValue | null {
  if (!params) {
    return null;
  }

  return parse(params as Record<string, string>);
}
