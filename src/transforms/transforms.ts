import { GraphQLSchema } from 'graphql';
import { Request, Result, Transform } from '../Interfaces';

export { Transform };

export function applySchemaTransforms(
  originalSchema: GraphQLSchema,
  transforms: Array<Transform>,
): GraphQLSchema {
  return transforms.reduce(
    (schema: GraphQLSchema, transform: Transform) =>
      transform.transformSchema ? transform.transformSchema(schema) : schema,
    originalSchema,
  );
}

export function applyRequestTransforms(
  originalRequest: Request,
  transforms: Array<Transform>,
): Request {
  return transforms.reduce(
    (request: Request, transform: Transform) =>
      transform.transformRequest
        ? transform.transformRequest(request)
        : request,

    originalRequest,
  );
}

export function applyResultTransforms(
  originalResult: any,
  transforms: Array<Transform>,
): any {
  return transforms.reduceRight(
    (result: any, transform: Transform) =>
      transform.transformResult ? transform.transformResult(result) : result,
    originalResult,
  );
}

export function composeTransforms(...transforms: Array<Transform>): Transform {
  const reverseTransforms = [...transforms].reverse();
  return {
    transformSchema(originalSchema: GraphQLSchema): GraphQLSchema {
      return applySchemaTransforms(originalSchema, transforms);
    },
    transformRequest(originalRequest: Request): Request {
      return applyRequestTransforms(originalRequest, reverseTransforms);
    },
    transformResult(result: Result): Result {
      return applyResultTransforms(result, reverseTransforms);
    },
  };
}
