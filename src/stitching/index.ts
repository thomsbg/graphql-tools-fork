import makeRemoteExecutableSchema, { createResolver as defaultCreateRemoteResolver } from './makeRemoteExecutableSchema';
import introspectSchema from './introspectSchema';
import mergeSchemas from './mergeSchemas';
import delegateToSchema from './delegateToSchema';
import delegateToRemoteSchema from './delegateToRemoteSchema';
import defaultMergedResolver from './defaultMergedResolver';
import { wrapField, extractField, renameField, createMergedResolver } from './createMergedResolver';
import { extractFields } from './extractFields';
import { collectFields } from './collectFields';


export {
  makeRemoteExecutableSchema,
  introspectSchema,
  mergeSchemas,

  // These are currently undocumented and not part of official API,
  // but exposed for the community use
  delegateToSchema,
  delegateToRemoteSchema,
  defaultCreateRemoteResolver,
  defaultMergedResolver,
  createMergedResolver,
  collectFields,
  extractFields,

  // TBD: deprecate in favor of createMergedResolver?
  // OR: fix naming to clarify that these functions return resolvers?
  wrapField,
  extractField,
  renameField,
};
