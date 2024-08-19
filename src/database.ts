import {
  DeclarationResult,
  DefinitionResult,
  DiagnosticResult,
  Document,
  DocumentLinkResult,
  DocumentSymbolResult,
  Edge,
  EdgeLabels,
  ElementTypes,
  FoldingRangeResult,
  HoverResult,
  Id,
  ImplementationResult,
  ItemEdgeProperties,
  MetaData,
  Moniker,
  MonikerKind,
  Project,
  Range,
  ReferenceResult,
  TypeDefinitionResult,
  types,
  Vertex,
  VertexLabels,
} from '@vscode/lsif-protocol';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import invariant from 'tiny-invariant';
import {URI} from 'vscode-uri';

namespace Locations {
  export function makeKey(location: types.Location): string {
    const range = location.range;
    return crypto
      .createHash('md5')
      .update(
        JSON.stringify(
          {
            d: location.uri,
            sl: range.start.line,
            sc: range.start.character,
            el: range.end.line,
            ec: range.end.character,
          },
          undefined,
          0,
        ),
      )
      .digest('base64');
  }
}

interface LegacyMetaData extends MetaData {
  projectRoot?: string;
}

interface MonikerAndKey extends Moniker {
  key: string;
}

interface Vertices {
  all: Map<Id, Vertex>;
  projects: Map<Id, Project>;
  documents: Map<Id, Document>;
  ranges: Map<Id, Range>;
}

interface In {
  contains: Map<Id, Project | Document>;
  moniker: Map<Id, Vertex[]>;
}

interface Out {
  contains: Map<Id, Document[] | Range[]>;
  item: Map<Id, ItemTarget[]>;
  next: Map<Id, Vertex>;
  moniker: Map<Id, MonikerAndKey>;
  documentSymbol: Map<Id, DocumentSymbolResult>;
  foldingRange: Map<Id, FoldingRangeResult>;
  documentLink: Map<Id, DocumentLinkResult>;
  diagnostic: Map<Id, DiagnosticResult>;
  declaration: Map<Id, DeclarationResult>;
  definition: Map<Id, DefinitionResult>;
  typeDefinition: Map<Id, TypeDefinitionResult>;
  hover: Map<Id, HoverResult>;
  references: Map<Id, ReferenceResult>;
  implementation: Map<Id, ImplementationResult>;
}

interface Indices {
  monikers: Map<string, MonikerAndKey[]>;
  contents: Map<string, string>;
  documents: Map<string, {hash: string; documents: Document[]}>;
}

interface ResultPath<T> {
  path: {vertex: Id; moniker: MonikerAndKey | undefined}[];
  result: {value: T; moniker: MonikerAndKey | undefined} | undefined;
}

type ItemTarget =
  | Range
  | {type: ItemEdgeProperties.declarations; range: Range}
  | {type: ItemEdgeProperties.definitions; range: Range}
  | {type: ItemEdgeProperties.references; range: Range}
  | {type: ItemEdgeProperties.referenceResults; result: ReferenceResult}
  | {type: ItemEdgeProperties.referenceLinks; result: MonikerAndKey};

export class JsonDatabase {
  private workspaceRoot!: string;

  private vertices: Vertices = {
    all: new Map(),
    projects: new Map(),
    documents: new Map(),
    ranges: new Map(),
  };

  public out: Out = {
    contains: new Map(),
    item: new Map(),
    next: new Map(),
    moniker: new Map(),
    documentSymbol: new Map(),
    foldingRange: new Map(),
    documentLink: new Map(),
    diagnostic: new Map(),
    declaration: new Map(),
    definition: new Map(),
    typeDefinition: new Map(),
    hover: new Map(),
    references: new Map(),
    implementation: new Map(),
  };

  private in: In = {
    contains: new Map(),
    moniker: new Map(),
  };

  private indices: Indices = {
    contents: new Map(),
    documents: new Map(),
    monikers: new Map(),
  };

  load(file: string) {
    const fileContent = fs.readFileSync(file, 'utf8').trim();
    for (const line of fileContent.split('\n')) {
      const element: Edge | Vertex = JSON.parse(line);
      switch (element.type) {
        case ElementTypes.vertex:
          this.processVertex(element);
          break;
        case ElementTypes.edge:
          this.processEdge(element);
          break;
        default:
          throw new Error(`Unexpected element type`);
      }
    }
  }

  private toDatabase(uri: string): string {
    return URI.parse(uri).toString(true);
  }

  private fromDatabase(uri: string): string {
    return URI.parse(uri).toString(true);
  }

  public declarations(uri: string, position: types.Position): types.Location | types.Location[] | undefined {
    return this.findTargets(uri, position, this.out.declaration);
  }

  public definitions(uri: string, position: types.Position): types.Location | types.Location[] | undefined {
    return this.findTargets(uri, position, this.out.definition);
  }

  private findTargets<T extends DefinitionResult | DeclarationResult>(
    uri: string,
    position: types.Position,
    edges: Map<Id, T>,
  ): types.Location | types.Location[] | undefined {
    const ranges = this.findRangesFromPosition(this.toDatabase(uri), position);
    if (ranges === undefined) {
      return undefined;
    }

    const resolveTargets = (result: types.Location[], dedupLocations: Set<string>, targetResult: T): void => {
      const ranges = this.item(targetResult);
      if (ranges === undefined) {
        return undefined;
      }
      for (const element of ranges) {
        this.addLocation(result, element, dedupLocations);
      }
    };

    const _findTargets = (
      result: types.Location[],
      dedupLocations: Set<string>,
      dedupMonikers: Set<string>,
      range: Range,
    ): void => {
      const resultPath = this.getResultPath(range.id, edges);
      if (resultPath.result === undefined) {
        return undefined;
      }

      const mostSpecificMoniker = this.getMostSpecificMoniker(resultPath);
      const monikers: MonikerAndKey[] = mostSpecificMoniker !== undefined ? [mostSpecificMoniker] : [];

      resolveTargets(result, dedupLocations, resultPath.result.value);
      for (const moniker of monikers) {
        if (dedupMonikers.has(moniker.key)) {
          continue;
        }
        dedupMonikers.add(moniker.key);
        const matchingMonikers = this.indices.monikers.get(moniker.key);
        if (matchingMonikers !== undefined) {
          for (const matchingMoniker of matchingMonikers) {
            const vertices = this.findVerticesForMoniker(matchingMoniker);
            if (vertices !== undefined) {
              for (const vertex of vertices) {
                const resultPath = this.getResultPath(vertex.id, edges);
                if (resultPath.result === undefined) {
                  continue;
                }
                resolveTargets(result, dedupLocations, resultPath.result.value);
              }
            }
          }
        }
      }
    };

    const result: types.Location[] = [];
    const dedupLocations: Set<string> = new Set();
    const dedupMonikers: Set<string> = new Set();
    for (const range of ranges) {
      _findTargets(result, dedupLocations, dedupMonikers, range);
    }
    return result;
  }

  public allDefinitions(uri: string): types.Location[] | undefined {
    const url = this.toDatabase(uri);
    const value = this.indices.documents.get(url);
    if (!value) {
      return undefined;
    }

    let results: types.Location[] = [];

    for (const document of value.documents) {
      const id = document.id;
      const contains = this.out.contains.get(id);
      if (contains === undefined || contains.length === 0) {
        return undefined;
      }

      for (const item of contains) {
        if (item.label !== VertexLabels.range) {
          continue;
        }

        const resultPath = this.getResultPath(item.id, this.out.definition);
        const moniker = this.getMostSpecificMoniker(resultPath);
        if (!moniker || moniker.kind !== MonikerKind.export) {
          continue;
        }

        // This is a scip thing. If the moniker ends with a dot then it is a
        // definition.
        if (!moniker.identifier.endsWith('.')) {
          continue;
        }

        // We don't want to include functions we know will have no references
        // like constructors and some react specific functions.
        if (
          moniker.identifier.includes('`<constructor>`') ||
          moniker.identifier.includes('#getDerivedStateFromProps()') ||
          moniker.identifier.includes('#propTypes')
        ) {
          continue;
        }

        const definitions = this.definitions(document.uri, item.start);
        if (Array.isArray(definitions)) {
          results = results.concat(definitions);
        } else if (definitions !== undefined) {
          results.push(definitions);
        }
      }
    }

    return results.length > 0 ? results.filter(item => item.uri === url) : undefined;
  }

  public references(
    uri: string,
    position: types.Position,
    context: types.ReferenceContext,
  ): types.Location[] | undefined {
    const ranges = this.findRangesFromPosition(this.toDatabase(uri), position);
    if (ranges === undefined) {
      return undefined;
    }

    const findReferences = (
      result: types.Location[],
      dedupLocations: Set<string>,
      dedupMonikers: Set<string>,
      range: Range,
    ): void => {
      const resultPath = this.getResultPath(range.id, this.out.references);
      if (resultPath.result === undefined) {
        return;
      }

      const mostSpecificMoniker = this.getMostSpecificMoniker(resultPath);
      const monikers: MonikerAndKey[] = mostSpecificMoniker !== undefined ? [mostSpecificMoniker] : [];
      this.resolveReferenceResult(result, dedupLocations, monikers, resultPath.result.value, context);
      for (const moniker of monikers) {
        if (dedupMonikers.has(moniker.key)) {
          continue;
        }
        dedupMonikers.add(moniker.key);
        const matchingMonikers = this.indices.monikers.get(moniker.key);
        if (matchingMonikers !== undefined) {
          for (const matchingMoniker of matchingMonikers) {
            if (moniker.id === matchingMoniker.id) {
              // continue;
            }
            const vertices = this.findVerticesForMoniker(matchingMoniker);

            if (vertices !== undefined) {
              for (const vertex of vertices) {
                const resultPath = this.getResultPath(vertex.id, this.out.references);
                if (resultPath.result === undefined) {
                  continue;
                }
                this.resolveReferenceResult(result, dedupLocations, monikers, resultPath.result.value, context);
              }
            }
          }
        }
      }
    };

    const result: types.Location[] = [];
    const dedupLocations: Set<string> = new Set();
    const dedupMonikers: Set<string> = new Set();
    for (const range of ranges) {
      findReferences(result, dedupLocations, dedupMonikers, range);
    }

    return result;
  }

  private findVerticesForMoniker(moniker: MonikerAndKey): Vertex[] | undefined {
    return this.in.moniker.get(moniker.id);
  }

  private getMostSpecificMoniker<T>(result: ResultPath<T>): MonikerAndKey | undefined {
    if (result.result?.moniker !== undefined) {
      return result.result.moniker;
    }
    for (let i = result.path.length - 1; i >= 0; i--) {
      if (result.path[i].moniker !== undefined) {
        return result.path[i].moniker;
      }
    }
    return undefined;
  }

  private processVertex(element: Vertex) {
    this.vertices.all.set(element.id, element);

    switch (element.label) {
      case VertexLabels.metaData:
        this.processMetaData(element);
        break;
      case VertexLabels.document:
        this.doProcessDocument(element);
        break;
      case VertexLabels.range:
        this.vertices.ranges.set(element.id, element);
        break;
      case VertexLabels.moniker:
        if (element.kind !== MonikerKind.local) {
          const key = crypto
            .createHash('md5')
            .update(JSON.stringify({s: element.scheme, i: element.identifier}, undefined, 0))
            .digest('base64');
          (element as Moniker & {key: string}).key = key;
          let values = this.indices.monikers.get(key);
          if (values === undefined) {
            values = [];
            this.indices.monikers.set(key, values);
          }
          values.push(element as MonikerAndKey);
        }
        break;
      case VertexLabels.packageInformation:
      case VertexLabels.definitionResult:
      case VertexLabels.implementationResult:
      case VertexLabels.resultSet:
      case VertexLabels.referenceResult:
      case VertexLabels.hoverResult:
        // SKIP
        break;
      default:
        throw new Error(`Unexpected vertex label: ${element.label}`);
    }
  }

  private processEdge(edge: Edge) {
    let property: any | undefined;
    if (edge.label === 'item') {
      property = edge.property;
    }

    if (Edge.is11(edge)) {
      this.doProcessEdge(edge.label, edge.outV, edge.inV, property);
    } else if (Edge.is1N(edge)) {
      for (const inV of edge.inVs) {
        this.doProcessEdge(edge.label, edge.outV, inV, property);
      }
    }
  }

  private doProcessEdge(label: EdgeLabels, outV: Id, inV: Id, property?: any) {
    const from: Vertex | undefined = this.vertices.all.get(outV);
    invariant(from !== undefined, `No vertex found for Id ${outV}`);

    const to: Vertex | undefined = this.vertices.all.get(inV);
    invariant(to !== undefined, `No vertex found for Id ${inV}`);

    let values: any[] | undefined;
    let itemTarget: ItemTarget | undefined;
    switch (label) {
      case EdgeLabels.contains:
        values = this.out.contains.get(from.id);
        if (values === undefined) {
          values = [to as any];
          this.out.contains.set(from.id, values);
        } else {
          values.push(to);
        }
        this.in.contains.set(to.id, from as any);
        break;
      case EdgeLabels.item:
        values = this.out.item.get(from.id);
        if (property !== undefined) {
          switch (property) {
            case ItemEdgeProperties.references:
              itemTarget = {type: property, range: to as Range};
              break;
            case ItemEdgeProperties.declarations:
              itemTarget = {type: property, range: to as Range};
              break;
            case ItemEdgeProperties.definitions:
              itemTarget = {type: property, range: to as Range};
              break;
            case ItemEdgeProperties.referenceResults:
              itemTarget = {type: property, result: to as ReferenceResult};
              break;
            case ItemEdgeProperties.referenceLinks:
              itemTarget = {type: property, result: to as MonikerAndKey};
          }
        } else {
          itemTarget = to as Range;
        }
        if (itemTarget !== undefined) {
          if (values === undefined) {
            values = [itemTarget];
            this.out.item.set(from.id, values);
          } else {
            values.push(itemTarget);
          }
        }
        break;
      case EdgeLabels.next:
        this.out.next.set(from.id, to);
        break;
      case EdgeLabels.moniker:
        this.out.moniker.set(from.id, to as MonikerAndKey);
        values = this.in.moniker.get(to.id);
        if (values === undefined) {
          values = [];
          this.in.moniker.set(to.id, values);
        }
        values.push(from);
        break;
      case EdgeLabels.textDocument_documentSymbol:
        this.out.documentSymbol.set(from.id, to as DocumentSymbolResult);
        break;
      case EdgeLabels.textDocument_foldingRange:
        this.out.foldingRange.set(from.id, to as FoldingRangeResult);
        break;
      case EdgeLabels.textDocument_documentLink:
        this.out.documentLink.set(from.id, to as DocumentLinkResult);
        break;
      case EdgeLabels.textDocument_diagnostic:
        this.out.diagnostic.set(from.id, to as DiagnosticResult);
        break;
      case EdgeLabels.textDocument_definition:
        this.out.definition.set(from.id, to as DefinitionResult);
        break;
      case EdgeLabels.textDocument_typeDefinition:
        this.out.typeDefinition.set(from.id, to as TypeDefinitionResult);
        break;
      case EdgeLabels.textDocument_hover:
        this.out.hover.set(from.id, to as HoverResult);
        break;
      case EdgeLabels.textDocument_references:
        this.out.references.set(from.id, to as ReferenceResult);
        break;
    }
  }

  private doProcessDocument(document: Document): void {
    // Normalize the document uri to the format used in VS Code.
    document.uri = URI.parse(document.uri).toString(true);
    const contents = document.contents !== undefined ? document.contents : 'No content provided.';
    this.vertices.documents.set(document.id, document);
    const hash = crypto.createHash('md5').update(contents).digest('base64');
    this.indices.contents.set(hash, contents);

    let value = this.indices.documents.get(document.uri);
    if (value === undefined) {
      value = {hash, documents: []};
      this.indices.documents.set(document.uri, value);
    }
    if (hash !== value.hash) {
      console.error(`Document ${document.uri} has different content.`);
    }
    value.documents.push(document);
  }

  private processMetaData(element: MetaData | LegacyMetaData) {
    if (this.workspaceRoot && 'projectRoot' in element && element.projectRoot !== this.workspaceRoot) {
      throw new Error('Multiple workspace roots found in the same database, you must create another database');
    }

    if ('projectRoot' in element && element.projectRoot) {
      this.workspaceRoot = element.projectRoot;
    }
  }

  private resolveReferenceResult(
    locations: types.Location[],
    dedupLocations: Set<string>,
    monikers: MonikerAndKey[],
    referenceResult: ReferenceResult,
    context: types.ReferenceContext,
  ): void {
    const targets = this.item(referenceResult);
    if (targets === undefined) {
      return undefined;
    }

    for (const target of targets) {
      if (target.type === ItemEdgeProperties.declarations && context.includeDeclaration) {
        this.addLocation(locations, target.range, dedupLocations);
      } else if (target.type === ItemEdgeProperties.definitions && context.includeDeclaration) {
        this.addLocation(locations, target.range, dedupLocations);
      } else if (target.type === ItemEdgeProperties.references) {
        this.addLocation(locations, target.range, dedupLocations);
      } else if (target.type === ItemEdgeProperties.referenceResults) {
        this.resolveReferenceResult(locations, dedupLocations, monikers, target.result, context);
      } else if (target.type === ItemEdgeProperties.referenceLinks) {
        monikers.push(target.result);
      } else if (target.type === ElementTypes.vertex && target.label === VertexLabels.range) {
        this.addLocation(locations, target as Range, dedupLocations);
      }
    }
  }

  private item(value: DefinitionResult | DeclarationResult): Range[];
  private item(value: ReferenceResult): ItemTarget[];
  private item(value: DeclarationResult | DefinitionResult | ReferenceResult): Range[] | ItemTarget[] | undefined {
    if (value.label === 'declarationResult') {
      return this.out.item.get(value.id) as Range[];
    } else if (value.label === 'definitionResult') {
      return this.out.item.get(value.id) as Range[];
    } else if (value.label === 'referenceResult') {
      return this.out.item.get(value.id) as ItemTarget[];
    } else {
      return undefined;
    }
  }

  private asRange(value: Range): types.Range {
    return {
      start: {
        line: value.start.line,
        character: value.start.character,
      },
      end: {
        line: value.end.line,
        character: value.end.character,
      },
    };
  }

  private addLocation(result: types.Location[], value: Range | types.Location, dedup: Set<string>): void {
    let location: types.Location;
    if (types.Location.is(value)) {
      location = value;
    } else {
      const document = this.in.contains.get(value.id)!;
      location = types.Location.create(this.fromDatabase((document as Document).uri), this.asRange(value));
    }
    const key = Locations.makeKey(location);
    if (!dedup.has(key)) {
      dedup.add(key);
      result.push(location);
    }
  }

  private getResultPath<T>(start: Id, edges: Map<Id, T>): ResultPath<T> {
    let currentId = start;
    const result: ResultPath<T> = {path: [], result: undefined};
    do {
      const value: T | undefined = edges.get(currentId);
      const moniker: MonikerAndKey | undefined = this.out.moniker.get(currentId);
      if (value !== undefined) {
        result.result = {value, moniker};
        return result;
      }
      result.path.push({vertex: currentId, moniker});
      const next = this.out.next.get(currentId);
      if (next === undefined) {
        return result;
      }
      currentId = next.id;
    } while (true);
  }

  private findRangesFromPosition(file: string, position: types.Position): Range[] | undefined {
    const value = this.indices.documents.get(file);
    if (value === undefined) {
      return undefined;
    }
    const result: Range[] = [];
    for (const document of value.documents) {
      const id = document.id;
      const contains = this.out.contains.get(id);
      if (contains === undefined || contains.length === 0) {
        return undefined;
      }

      let candidate: Range | undefined;
      for (const item of contains) {
        if (item.label !== VertexLabels.range) {
          continue;
        }
        if (JsonDatabase.containsPosition(item, position)) {
          if (!candidate) {
            candidate = item;
          } else {
            if (JsonDatabase.containsRange(candidate, item)) {
              candidate = item;
            }
          }
        }
      }
      if (candidate !== undefined) {
        result.push(candidate);
      }
    }
    return result.length > 0 ? result : undefined;
  }

  private static containsPosition(range: types.Range, position: types.Position): boolean {
    if (position.line < range.start.line || position.line > range.end.line) {
      return false;
    }
    if (position.line === range.start.line && position.character < range.start.character) {
      return false;
    }
    if (position.line === range.end.line && position.character > range.end.character) {
      return false;
    }
    return true;
  }

  /**
   * Test if `otherRange` is in `range`. If the ranges are equal, will return
   * true.
   */
  public static containsRange(range: types.Range, otherRange: types.Range): boolean {
    if (otherRange.start.line < range.start.line || otherRange.end.line < range.start.line) {
      return false;
    }
    if (otherRange.start.line > range.end.line || otherRange.end.line > range.end.line) {
      return false;
    }
    if (otherRange.start.line === range.start.line && otherRange.start.character < range.start.character) {
      return false;
    }
    if (otherRange.end.line === range.end.line && otherRange.end.character > range.end.character) {
      return false;
    }
    return true;
  }
}
