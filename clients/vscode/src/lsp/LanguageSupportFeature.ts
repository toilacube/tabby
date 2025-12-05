import { commands, Uri, Position, Range, DocumentSymbol, SymbolInformation } from "vscode";
import { BaseLanguageClient, StaticFeature, FeatureState, Disposable } from "vscode-languageclient";
import {
  ClientCapabilities,
  LanguageSupportDeclarationRequest,
  LanguageSupportSemanticTokensRangeRequest,
} from "tabby-agent";
import { DeclarationParams, SemanticTokensRangeParams } from "vscode-languageclient";

/**
 * Checks if a position is contained within a range
 */
function isPositionInRange(position: Position, range: Range): boolean {
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
 * Finds the smallest symbol that contains the given position
 * Returns the full range of the symbol (including its body)
 */
function findContainingSymbol(
  symbols: (DocumentSymbol | SymbolInformation)[],
  targetPosition: Position,
): Range | undefined {
  let bestMatch: Range | undefined = undefined;
  let bestMatchSize = Infinity;

  const processSymbol = (symbol: DocumentSymbol | SymbolInformation) => {
    let symbolRange: Range;
    let selectionRange: Range;

    if ("children" in symbol) {
      // DocumentSymbol has both range (full body) and selectionRange (just the name)
      symbolRange = symbol.range;
      selectionRange = symbol.selectionRange;
    } else {
      // SymbolInformation only has location.range
      symbolRange = symbol.location.range;
      selectionRange = symbol.location.range;
    }

    // Check if the target position is within the symbol's selection range or at its start
    if (isPositionInRange(targetPosition, selectionRange)) {
      const rangeSize =
        (symbolRange.end.line - symbolRange.start.line) * 10000 +
        (symbolRange.end.character - symbolRange.start.character);
      if (rangeSize < bestMatchSize) {
        bestMatchSize = rangeSize;
        bestMatch = symbolRange;
      }
    }

    // Process children for DocumentSymbol
    if ("children" in symbol && symbol.children) {
      for (const child of symbol.children) {
        processSymbol(child);
      }
    }
  };

  for (const symbol of symbols) {
    processSymbol(symbol);
  }

  return bestMatch;
}

export class LanguageSupportFeature implements StaticFeature {
  private disposables: Disposable[] = [];

  constructor(private readonly client: BaseLanguageClient) {}

  getState(): FeatureState {
    return { kind: "static" };
  }

  fillInitializeParams() {
    // nothing
  }

  fillClientCapabilities(capabilities: ClientCapabilities): void {
    capabilities.tabby = {
      ...capabilities.tabby,
      languageSupport: true,
    };
  }

  preInitialize(): void {
    // nothing
  }

  initialize(): void {
    this.disposables.push(
      this.client.onRequest(LanguageSupportDeclarationRequest.type, async (params: DeclarationParams) => {
        const result = await commands.executeCommand(
          "vscode.executeDefinitionProvider",
          Uri.parse(params.textDocument.uri),
          new Position(params.position.line, params.position.character),
        );
        const items = Array.isArray(result) ? result : [result];
        const locations = await Promise.all(
          items.map(async (item) => {
            const targetUri = "targetUri" in item ? item.targetUri : item.uri;
            const targetRange =
              "targetRange" in item
                ? new Range(
                    item.targetRange.start.line,
                    item.targetRange.start.character,
                    item.targetRange.end.line,
                    item.targetRange.end.character,
                  )
                : new Range(
                    item.range.start.line,
                    item.range.start.character,
                    item.range.end.line,
                    item.range.end.character,
                  );

            // Get document symbols to find the full symbol range
            const documentSymbols = await commands.executeCommand<(DocumentSymbol | SymbolInformation)[]>(
              "vscode.executeDocumentSymbolProvider",
              targetUri,
            );

            let finalRange = targetRange;

            if (documentSymbols && documentSymbols.length > 0) {
              // Find the symbol that contains the definition position
              const containingSymbolRange = findContainingSymbol(
                documentSymbols,
                new Position(targetRange.start.line, targetRange.start.character),
              );

              if (containingSymbolRange) {
                finalRange = containingSymbolRange;
              }
            }

            return {
              uri: targetUri.toString(),
              range: {
                start: {
                  line: finalRange.start.line,
                  character: finalRange.start.character,
                },
                end: {
                  line: finalRange.end.line,
                  character: finalRange.end.character,
                },
              },
            };
          }),
        );
        return locations;
      }),
    );
    this.disposables.push(
      this.client.onRequest(
        LanguageSupportSemanticTokensRangeRequest.type,
        async (params: SemanticTokensRangeParams) => {
          return {
            legend: await commands.executeCommand(
              "vscode.provideDocumentRangeSemanticTokensLegend",
              Uri.parse(params.textDocument.uri),
              new Range(
                params.range.start.line,
                params.range.start.character,
                params.range.end.line,
                params.range.end.character,
              ),
            ),
            tokens: await commands.executeCommand(
              "vscode.provideDocumentRangeSemanticTokens",
              Uri.parse(params.textDocument.uri),
              new Range(
                params.range.start.line,
                params.range.start.character,
                params.range.end.line,
                params.range.end.character,
              ),
            ),
          };
        },
      ),
    );
  }

  clear(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables = [];
  }
}
