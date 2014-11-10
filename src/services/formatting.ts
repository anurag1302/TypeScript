///<reference path='services.ts' />
///<reference path='formatting\indentation.ts' />
///<reference path='formatting\formattingScanner.ts' />
///<reference path='formatting\rulesProvider.ts' />

module ts.formatting {

    export interface TextRangeWithKind extends TextRange {
        kind: SyntaxKind;
    }

    export interface TokenInfo {
        leadingTrivia: TextRangeWithKind[];
        token: TextRangeWithKind;
        trailingTrivia: TextRangeWithKind[];
    }

    const enum Constants {
        Unknown = -1
    }

    /* 
     * Indentation for the scope that can be dynamically recomputed.
     * i.e 
     * while(true)
     * { var x;
     * }
     * Normally indentation is applied only to the first token in line so at glance 'var' should not be touched. 
     * However if some format rule adds new line between '}' and 'var' 'var' will become
     * the first token in line so it should be indented
     */
    interface DynamicIndentation {
        getIndentationForToken(tokenLine: number, tokenKind: SyntaxKind): number;
        getIndentationForComment(owningToken: SyntaxKind): number;
        /**
          * Indentation for open and close tokens of the node if it is block or another node that needs special indentation
          * ... {
          * .........<child>
          * ....}
          *  ____ - indentation
          *      ____ - delta
          **/
        getIndentation(): number;
        /**
          * Prefered relative indentation for child nodes
          */
        getDelta(): number;
        recomputeIndentation(lineAddedByFormatting: boolean): void;
    }

    interface Indentation {
        indentation: number;
        delta: number
    }

    export function formatOnEnter(position: number, sourceFile: SourceFile, rulesProvider: RulesProvider, options: FormatCodeOptions): TextChange[] {
        var line = sourceFile.getLineAndCharacterFromPosition(position).line;
        Debug.assert(line >= 2);
        // get the span for the previous\current line
        var span = {
            // get start position for the previous line
            pos: getStartPositionOfLine(line - 1, sourceFile),
            // get end position for the current line (end value is exclusive so add 1 to the result)
            end: getEndLinePosition(line, sourceFile) + 1
        }
        return formatSpan(span, sourceFile, options, rulesProvider, FormattingRequestKind.FormatOnEnter);
    }

    export function formatOnSemicolon(position: number, sourceFile: SourceFile, rulesProvider: RulesProvider, options: FormatCodeOptions): TextChange[] {
        return formatOutermostParent(position, SyntaxKind.SemicolonToken, sourceFile, options, rulesProvider, FormattingRequestKind.FormatOnSemicolon);
    }

    export function formatOnClosingCurly(position: number, sourceFile: SourceFile, rulesProvider: RulesProvider, options: FormatCodeOptions): TextChange[] {
        return formatOutermostParent(position, SyntaxKind.CloseBraceToken, sourceFile, options, rulesProvider, FormattingRequestKind.FormatOnClosingCurlyBrace);
    }

    export function formatDocument(sourceFile: SourceFile, rulesProvider: RulesProvider, options: FormatCodeOptions): TextChange[] {
        var span = {
            pos: 0,
            end: sourceFile.text.length
        };
        return formatSpan(span, sourceFile, options, rulesProvider, FormattingRequestKind.FormatDocument);
    }

    export function formatSelection(start: number, end: number, sourceFile: SourceFile, rulesProvider: RulesProvider, options: FormatCodeOptions): TextChange[] {
        // format from the beginning of the line
        var span = {
            pos: getStartLinePositionForPosition(start, sourceFile),
            end: end
        };
        return formatSpan(span, sourceFile, options, rulesProvider, FormattingRequestKind.FormatSelection);
    }

    function formatOutermostParent(position: number, expectedLastToken: SyntaxKind, sourceFile: SourceFile, options: FormatCodeOptions, rulesProvider: RulesProvider, requestKind: FormattingRequestKind): TextChange[] {
        var parent = findOutermostParent(position, expectedLastToken, sourceFile);
        if (!parent) {
            return [];
        }
        var span = {
            pos: getStartLinePositionForPosition(parent.getStart(sourceFile), sourceFile),
            end: parent.end
        };
        return formatSpan(span, sourceFile, options, rulesProvider, requestKind);
    }

    function findOutermostParent(position: number, expectedTokenKind: SyntaxKind, sourceFile: SourceFile): Node {
        var precedingToken = findPrecedingToken(position, sourceFile);
        if (!precedingToken || precedingToken.kind !== expectedTokenKind) {
            return undefined;
        }

        // walk up and search for the parent node that ends at the same position with precedingToken.
        // for cases like this
        // 
        // var x = 1;
        // while (true) {
        // } 
        // after typing close curly in while statement we want to reformat just the while statement.
        // However if we just walk upwards searching for the parent that has the same end value - 
        // we'll end up with the whole source file. isListElement allows to stop on the list element level
        var current = precedingToken;
        while (current &&
            current.parent &&
            current.parent.end === precedingToken.end &&
            !isListElement(current.parent, current)) {
            current = current.parent;
        }

        return current;
    }
    
    // Returns true if node is a element in some list in parent
    // i.e. parent is class declaration with the list of members and node is one of members.
    function isListElement(parent: Node, node: Node): boolean {
        switch (parent.kind) {
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.InterfaceDeclaration:
                return rangeContainsRange((<InterfaceDeclaration>parent).members, node);
            case SyntaxKind.ModuleDeclaration:
                var body = (<ModuleDeclaration>parent).body;
                return body && body.kind === SyntaxKind.Block && rangeContainsRange((<Block>body).statements, node);
            case SyntaxKind.SourceFile:
            case SyntaxKind.Block:
            case SyntaxKind.TryBlock:
            case SyntaxKind.CatchBlock:
            case SyntaxKind.FinallyBlock:
            case SyntaxKind.ModuleBlock:
                return rangeContainsRange((<Block>parent).statements, node)
        }

        return false;
    }

    /** find node that fully contains given text range */
    function findEnclosingNode(range: TextRange, sourceFile: SourceFile): Node {
        return find(sourceFile);

        function find(n: Node): Node {
            var candidate = forEachChild(n, c => startEndContainsRange(c.getStart(sourceFile), c.end, range) && c);
            if (candidate) {
                var result = find(candidate);
                if (result) {
                    return result;
                }
            }

            return n;
        }
    }

    /** formatting is not applied to ranges that contain parse errors.
      * This function will return a predicate that for a given text range will tell
      * if there are any parse errors that overlap with the range.
      */
    function prepareRangeContainsErrorFunction(errors: Diagnostic[], originalRange: TextRange): (r: TextRange) => boolean {
        if (!errors.length) {
            return rangeHasNoErrors;
        }
        
        // pick only errors that fall in range
        var sorted = errors
            .filter(d => d.isParseError && rangeOverlapsWithStartEnd(originalRange, d.start, d.start + d.length))
            .sort((e1, e2) => e1.start - e2.start);

        if (!sorted.length) {
            return rangeHasNoErrors;
        }

        var index = 0;

        return r => {
            // in current implementation sequence of arguments [r1, r2...] is monotonically increasing.
            // 'index' tracks the index of the most recent error that was checked.
            while (true) {
                if (index >= sorted.length) {
                    // all errors in the range were already checked -> no error in specified range 
                    return false;
                }

                var error = sorted[index];
                if (r.end <= error.start) {
                    // specified range ends before the error refered by 'index' - no error in range
                    return false;
                }

                if (startEndOverlapsWithStartEnd(r.pos, r.end, error.start, error.start + error.length)) {
                    // specified range overlaps with error range
                    return true;
                }

                index++;
            }
        };

        function rangeHasNoErrors(r: TextRange): boolean {
            return false;
        }
    }

    function formatSpan(originalRange: TextRange,
        sourceFile: SourceFile,
        options: FormatCodeOptions,
        rulesProvider: RulesProvider,
        requestKind: FormattingRequestKind): TextChange[] {

        var rangeContainsError = prepareRangeContainsErrorFunction(sourceFile.syntacticErrors, originalRange);

        // formatting context is used by rules provider
        var formattingContext = new FormattingContext(sourceFile, requestKind);

        var formattingScanner = getFormattingScanner(sourceFile, originalRange.pos, originalRange.end);

        // find the smallest node that fully wraps the range and compute the initial indentation for the node
        var enclosingNode = findEnclosingNode(originalRange, sourceFile);
        var initialIndentation = SmartIndenter.getIndentationForNode(enclosingNode, originalRange, sourceFile, options);

        var previousRangeHasError: boolean;
        var previousRange: TextRangeWithKind;
        var previousParent: Node;
        var previousRangeStartLine: number;

        var edits: TextChange[] = [];

        formattingScanner.advance();

        if (formattingScanner.isOnToken()) {
            var startLine = sourceFile.getLineAndCharacterFromPosition(enclosingNode.getStart(sourceFile)).line;
            var delta = SmartIndenter.shouldIndentChildNode(enclosingNode.kind, SyntaxKind.Unknown) ? options.IndentSize : 0;
            processNode(enclosingNode, enclosingNode, startLine, initialIndentation, delta);
        }

        formattingScanner.close();

        return edits;

        // local functions

        /** Tries to compute the indentation for a list element.
          * If list element is not in range then 
          * function will pick its actual indentation 
          * so it can be pushed downstream as inherited indentation.
          * If list element is in the range - its indentation will be equal 
          * to inherited indentation from its predecessors.
          */
        function tryComputeIndentationForListItem(startPos: number, 
            endPos: number, 
            parentStartLine: number, 
            range: TextRange, 
            inheritedIndentation: number): number {
            
            if (rangeOverlapsWithStartEnd(range, startPos, endPos)) {
                if (inheritedIndentation !== Constants.Unknown) {
                    return inheritedIndentation;
                }
            }
            else {
                var startLine = sourceFile.getLineAndCharacterFromPosition(startPos).line;
                var startLinePosition = getStartLinePositionForPosition(startPos, sourceFile);
                var column = SmartIndenter.findFirstNonWhitespaceColumn(startLinePosition, startPos, sourceFile, options);
                if (startLine !== parentStartLine || startPos === column) {
                    return column
                }
            }

            return Constants.Unknown;
        }
        
        function computeIndentation(
            node: TextRangeWithKind,
            startLine: number,
            inheritedIndentation: number,
            parent: Node,
            parentIndentation: DynamicIndentation,
            effectiveParentStartLine: number): Indentation {

            var indentation = inheritedIndentation;
            var delta = 0;
            if (indentation === Constants.Unknown) {
                if (isSomeBlock(node.kind)) {
                    // blocks should be indented in 
                    // - other blocks
                    // - source file 
                    // - switch\default clauses
                    if (isSomeBlock(parent.kind) ||
                        parent.kind === SyntaxKind.SourceFile ||
                        parent.kind === SyntaxKind.CaseClause ||
                        parent.kind === SyntaxKind.DefaultClause) {

                        indentation = parentIndentation.getIndentation() + parentIndentation.getDelta();
                    }
                    else {
                        indentation = parentIndentation.getIndentation();
                    }
                }
                else {
                    if (SmartIndenter.childStartsOnTheSameLineWithElseInIfStatement(parent, node, startLine, sourceFile)) {
                        indentation = parentIndentation.getIndentation();
                    }
                    else {
                        indentation = parentIndentation.getIndentation() + parentIndentation.getDelta();
                    }
                }
            }

            if (SmartIndenter.shouldIndentChildNode(node.kind, SyntaxKind.Unknown)) {
                delta = options.IndentSize;
            }

            if (effectiveParentStartLine === startLine) {
                // if node is located on the same line with the parent
                // - inherit indentation from the parent
                // - push children if either parent of node itself has non-zero delta
                indentation = parentIndentation.getIndentation();
                delta = Math.min(options.IndentSize, parentIndentation.getDelta() + delta);
            }
            return {
                indentation: indentation,
                delta: delta
            }
        }

        function getDynamicIndentation(node: Node, nodeStartLine: number, indentation: number, delta: number): DynamicIndentation {
            return {
                getIndentationForComment: kind => {
                    switch (kind) {
                        // preceding comment to the token that closes the indentation scope inherits the indentation from the scope
                        // ..  {
                        //     // comment
                        // }
                        case SyntaxKind.CloseBraceToken:
                        case SyntaxKind.CloseBracketToken:
                            return indentation + delta;
                    }
                    return indentation;
                },
                getIndentationForToken: (line, kind) => {
                    switch (kind) {
                        // open and close brace, 'else' and 'while' (in do statement) tokens has indentation of the parent
                        case SyntaxKind.OpenBraceToken:
                        case SyntaxKind.CloseBraceToken:
                        case SyntaxKind.OpenBracketToken:
                        case SyntaxKind.CloseBracketToken:
                        case SyntaxKind.ElseKeyword:
                        case SyntaxKind.WhileKeyword:
                            return indentation;
                        default:
                            return nodeStartLine !== line ? indentation + delta : indentation;
                    }
                },
                getIndentation: () => indentation,
                getDelta: () => delta,
                recomputeIndentation: lineAdded => {
                    if (node.parent && SmartIndenter.shouldIndentChildNode(node.parent.kind, node.kind)) {
                        if (lineAdded) {
                            indentation += options.IndentSize;
                        }
                        else {
                            indentation -= options.IndentSize;
                        }

                        if (SmartIndenter.shouldIndentChildNode(node.kind, SyntaxKind.Unknown)) {
                            delta = options.IndentSize;
                        }
                        else {
                            delta = 0;
                        }
                    }
                },
            }
        }

        function processNode(node: Node, contextNode: Node, nodeStartLine: number, indentation: number, delta: number) {
            if (!rangeOverlapsWithStartEnd(originalRange, node.getStart(sourceFile), node.getEnd())) {
                return;
            }

            var nodeIndentation = getDynamicIndentation(node, nodeStartLine, indentation, delta);

            var childContextNode = contextNode;
            forEachChild(
                node,
                child => {
                    processChildNode(child, Constants.Unknown, nodeIndentation, nodeStartLine, /*isListElement*/ false)
                },
                (nodes: NodeArray<Node>) => {
                    var listStartToken = getOpenTokenForList(node, nodes);
                    var listEndToken = getCloseTokenForOpenToken(listStartToken);

                    var listIndentation = nodeIndentation;
                    var startLine = nodeStartLine;

                    if (listStartToken !== SyntaxKind.Unknown) {
                        // introduce a new indentation scope for lists (including list start and end tokens)
                        while (formattingScanner.isOnToken()) {
                            var tokenInfo = formattingScanner.readTokenInfo(node);
                            if (tokenInfo.token.end > nodes.pos) {
                                break;
                            }
                            else if (tokenInfo.token.kind === listStartToken) {
                                // consume list start token
                                startLine = sourceFile.getLineAndCharacterFromPosition(tokenInfo.token.pos).line;
                                var indentation = 
                                    computeIndentation(tokenInfo.token, startLine, Constants.Unknown, node, nodeIndentation, startLine);

                                listIndentation = getDynamicIndentation(node, nodeStartLine, indentation.indentation, indentation.delta);
                                consumeTokenAndAdvanceScanner(tokenInfo, node, listIndentation);
                            }
                            else {
                                // consume any tokens that precede the list as child elements of 'node' using its indentation scope
                                consumeTokenAndAdvanceScanner(tokenInfo, node, nodeIndentation);
                            }
                        }
                    }

                    var inheritedIndentation = Constants.Unknown;
                    for (var i = 0, len = nodes.length; i < len; ++i) {
                        inheritedIndentation = processChildNode(nodes[i], inheritedIndentation, listIndentation, startLine, /*isListElement*/ true)
                    }

                    if (listEndToken !== SyntaxKind.Unknown) {
                        if (formattingScanner.isOnToken()) {
                            var tokenInfo = formattingScanner.readTokenInfo(node);
                            if (tokenInfo.token.kind === listEndToken) {
                                // consume list end token
                                consumeTokenAndAdvanceScanner(tokenInfo, node, listIndentation);
                            }
                        }
                    }
                });

            // proceed any tokens in the node that are located after child nodes
            while (formattingScanner.isOnToken()) {
                var tokenInfo = formattingScanner.readTokenInfo(node);
                if (tokenInfo.token.end > node.end) {
                    break;
                }
                consumeTokenAndAdvanceScanner(tokenInfo, node, nodeIndentation);
            }

            function processChildNode(
                child: Node,
                inheritedIndentation: number,
                nodeIndentation: DynamicIndentation,
                parentStartLine: number,
                isListItem: boolean): number {

                var childStartPos = child.getStart(sourceFile);

                var childStart = sourceFile.getLineAndCharacterFromPosition(childStartPos);
                var childIndentationAmount = isListItem
                    ? tryComputeIndentationForListItem(childStartPos, child.end, parentStartLine, originalRange, inheritedIndentation)
                    : Constants.Unknown;

                if (isListItem && childIndentationAmount !== Constants.Unknown) {
                    inheritedIndentation = childIndentationAmount;
                }

                // child node is outside the target range - do not dive inside
                if (!rangeOverlapsWithStartEnd(originalRange, child.pos, child.end)) {
                    return inheritedIndentation;
                }

                if (child.kind === SyntaxKind.Missing) {
                    return inheritedIndentation;
                }

                while (formattingScanner.isOnToken()) {
                    // proceed any parent tokens that are located prior to child.getStart()
                    var tokenInfo = formattingScanner.readTokenInfo(node);
                    if (tokenInfo.token.end > childStartPos) {
                        break;
                    }

                    consumeTokenAndAdvanceScanner(tokenInfo, node, nodeIndentation);
                }

                if (!formattingScanner.isOnToken()) {
                    return inheritedIndentation;
                }

                if (isToken(child)) {
                    // if child node is a token, it does not impact indentation, proceed it using parent indentation scope rules
                    var tokenInfo = formattingScanner.readTokenInfo(node);
                    Debug.assert(tokenInfo.token.end === child.end);
                    consumeTokenAndAdvanceScanner(tokenInfo, node, nodeIndentation);
                    return inheritedIndentation;
                }

                var childIndentation = computeIndentation(child, childStart.line, childIndentationAmount, node, nodeIndentation, parentStartLine);

                processNode(child, childContextNode, childStart.line, childIndentation.indentation, childIndentation.delta);

                childContextNode = node;

                return inheritedIndentation;
            }

            function consumeTokenAndAdvanceScanner(currentTokenInfo: TokenInfo, parent: Node, indentation: DynamicIndentation): void {
                Debug.assert(rangeContainsRange(parent, currentTokenInfo.token));

                var lastTriviaWasNewLine = formattingScanner.lastTrailingTriviaWasNewLine();
                var indentToken = false;

                if (currentTokenInfo.leadingTrivia) {
                    processTrivia(currentTokenInfo.leadingTrivia, parent, childContextNode, indentation);
                }

                var lineAdded: boolean;
                var isTokenInRange = rangeContainsRange(originalRange, currentTokenInfo.token);

                var tokenStart = sourceFile.getLineAndCharacterFromPosition(currentTokenInfo.token.pos);
                if (isTokenInRange) {
                    // save prevStartLine since processRange will overwrite this value with current ones
                    var prevStartLine = previousRangeStartLine;
                    lineAdded = processRange(currentTokenInfo.token, tokenStart, parent, childContextNode, indentation);
                    if (lineAdded !== undefined) {
                        indentToken = lineAdded;
                    }
                    else {
                        indentToken = lastTriviaWasNewLine && tokenStart.line !== prevStartLine;
                    }
                }

                if (currentTokenInfo.trailingTrivia) {
                    processTrivia(currentTokenInfo.trailingTrivia, parent, childContextNode, indentation);
                }

                if (indentToken) {
                    var indentNextTokenOrTrivia = true;
                    if (currentTokenInfo.leadingTrivia) {
                        for (var i = 0, len = currentTokenInfo.leadingTrivia.length; i < len; ++i) {
                            var triviaItem = currentTokenInfo.leadingTrivia[i];
                            if (!rangeContainsRange(originalRange, triviaItem)) {
                                continue;
                            }

                            var triviaStartLine = sourceFile.getLineAndCharacterFromPosition(triviaItem.pos).line;
                            switch (triviaItem.kind) {
                                case SyntaxKind.MultiLineCommentTrivia:
                                    var commentIndentation = indentation.getIndentationForComment(currentTokenInfo.token.kind);
                                    indentMultilineComment(triviaItem, commentIndentation, /*firstLineIsIndented*/ !indentNextTokenOrTrivia);
                                    indentNextTokenOrTrivia = false;
                                    break;
                                case SyntaxKind.SingleLineCommentTrivia:
                                    if (indentNextTokenOrTrivia) {
                                        var commentIndentation = indentation.getIndentationForComment(currentTokenInfo.token.kind);
                                        insertIndentation(triviaItem.pos, commentIndentation, /*lineAdded*/ false);
                                        indentNextTokenOrTrivia = false;
                                    }
                                    break;
                                case SyntaxKind.NewLineTrivia:
                                    indentNextTokenOrTrivia = true;
                                    break;
                            }
                        }
                    }

                    // indent token only if is it is in target range and does not overlap with any error ranges
                    if (isTokenInRange && !rangeContainsError(currentTokenInfo.token)) {
                        var tokenIndentation = indentation.getIndentationForToken(tokenStart.line, currentTokenInfo.token.kind);
                        insertIndentation(currentTokenInfo.token.pos, tokenIndentation, lineAdded);
                    }
                }

                formattingScanner.advance();

                childContextNode = parent;
            }
        }

        function processTrivia(trivia: TextRangeWithKind[], parent: Node, contextNode: Node, indentation: DynamicIndentation): void {
            for (var i = 0, len = trivia.length; i < len; ++i) {
                var triviaItem = trivia[i];
                if (isComment(triviaItem.kind) && rangeContainsRange(originalRange, triviaItem)) {
                    var triviaItemStart = sourceFile.getLineAndCharacterFromPosition(triviaItem.pos);
                    processRange(triviaItem, triviaItemStart, parent, contextNode, indentation);
                }
            }
        }

        function processRange(range: TextRangeWithKind, rangeStart: LineAndCharacter, parent: Node, contextNode: Node, indentation: DynamicIndentation): boolean {
            var rangeHasError = rangeContainsError(range);
            var lineAdded: boolean;
            if (!rangeHasError && !previousRangeHasError) {
                if (!previousRange) {
                    // trim whitespaces starting from the beginning of the span up to the current line
                    var originalStart = sourceFile.getLineAndCharacterFromPosition(originalRange.pos);
                    trimTrailingWhitespacesForLines(originalStart.line, rangeStart.line);
                }
                else {
                    lineAdded = 
                        processPair(range, rangeStart.line, parent, previousRange, previousRangeStartLine, previousParent, contextNode, indentation)
                }
            }

            previousRange = range;
            previousParent = parent;
            previousRangeStartLine = rangeStart.line;
            previousRangeHasError = rangeHasError;

            return lineAdded;
        }

        function processPair(currentItem: TextRangeWithKind,
            currentStartLine: number,
            currentParent: Node,
            previousItem: TextRangeWithKind,
            previousStartLine: number,
            previousParent: Node,
            contextNode: Node,
            indentation: DynamicIndentation): boolean {

            formattingContext.updateContext(previousItem, previousParent, currentItem, currentParent, contextNode);

            var rule = rulesProvider.getRulesMap().GetRule(formattingContext);

            var trimTrailingWhitespaces: boolean;
            var lineAdded: boolean;
            if (rule) {
                applyRuleEdits(rule, previousItem, previousStartLine, currentItem, currentStartLine);

                if (rule.Operation.Action & (RuleAction.Space | RuleAction.Delete) && currentStartLine !== previousStartLine) {
                    // Handle the case where the next line is moved to be the end of this line. 
                    // In this case we don't indent the next line in the next pass.
                    if (currentParent.getStart(sourceFile) === currentItem.pos) {
                        lineAdded = false;
                    }
                }
                else if (rule.Operation.Action & RuleAction.NewLine && currentStartLine === previousStartLine) {
                    // Handle the case where token2 is moved to the new line. 
                    // In this case we indent token2 in the next pass but we set
                    // sameLineIndent flag to notify the indenter that the indentation is within the line.
                    if (currentParent.getStart(sourceFile) === currentItem.pos) {
                        lineAdded = true;
                    }
                }

                if (lineAdded !== undefined) {
                    indentation.recomputeIndentation(lineAdded);
                }

                // We need to trim trailing whitespace between the tokens if they were on different lines, and no rule was applied to put them on the same line
                trimTrailingWhitespaces =
                (rule.Operation.Action & (RuleAction.NewLine | RuleAction.Space)) &&
                rule.Flag !== RuleFlags.CanDeleteNewLines;
            }
            else {
                trimTrailingWhitespaces = true;
            }

            if (currentStartLine !== previousStartLine && trimTrailingWhitespaces) {
                // We need to trim trailing whitespace between the tokens if they were on different lines, and no rule was applied to put them on the same line
                trimTrailingWhitespacesForLines(previousStartLine, currentStartLine, previousItem);
            }

            return lineAdded;
        }

        function insertIndentation(pos: number, indentation: number, lineAdded: boolean): void {
            var indentationString = getIndentationString(indentation, options);
            if (lineAdded) {
                // new line is added before the token by the formatting rules
                // insert indentation string at the very beginning of the token
                recordReplace(pos, 0, indentationString);
            }
            else {
                var tokenStart = sourceFile.getLineAndCharacterFromPosition(pos);
                if (indentation !== tokenStart.character - 1) {
                    var startLinePosition = getStartPositionOfLine(tokenStart.line, sourceFile);
                    recordReplace(startLinePosition, tokenStart.character - 1, indentationString);
                }
            }
        }

        function indentMultilineComment(commentRange: TextRange, indentation: number, firstLineIsIndented: boolean) {
            // split comment in lines
            var startLine = sourceFile.getLineAndCharacterFromPosition(commentRange.pos).line;
            var endLine = sourceFile.getLineAndCharacterFromPosition(commentRange.end).line;

            if (startLine === endLine) {
                if (!firstLineIsIndented) {
                    // treat as single line comment
                    insertIndentation(commentRange.pos, indentation, /*lineAdded*/ false);
                }
                return;
            }
            else {
                var parts: TextRange[] = [];
                var startPos = commentRange.pos;
                for (var line = startLine; line < endLine; ++line) {
                    var endOfLine = getEndLinePosition(line, sourceFile);
                    parts.push({ pos: startPos, end: endOfLine });
                    startPos = getStartPositionOfLine(line + 1, sourceFile);
                }

                parts.push({ pos: startPos, end: commentRange.end });
            }

            var startLinePos = getStartPositionOfLine(startLine, sourceFile);

            var nonWhitespaceColumnInFirstPart =
                SmartIndenter.findFirstNonWhitespaceColumn(startLinePos, parts[0].pos, sourceFile, options);

            if (indentation === nonWhitespaceColumnInFirstPart) {
                return;
            }

            var startIndex = 0;
            if (firstLineIsIndented) {
                startIndex = 1;
                startLine++;
            }

            // shift all parts on the delta size
            var delta = indentation - nonWhitespaceColumnInFirstPart;
            for (var i = startIndex, len = parts.length; i < len; ++i, ++startLine) {
                var startLinePos = getStartPositionOfLine(startLine, sourceFile);
                var nonWhitespaceColumn =
                    i === 0
                        ? nonWhitespaceColumnInFirstPart
                        : SmartIndenter.findFirstNonWhitespaceColumn(parts[i].pos, parts[i].end, sourceFile, options);

                var newIndentation = nonWhitespaceColumn + delta;
                if (newIndentation > 0) {
                    var indentationString = getIndentationString(newIndentation, options);
                    recordReplace(startLinePos, nonWhitespaceColumn, indentationString);
                }
                else {
                    recordDelete(startLinePos, nonWhitespaceColumn);
                }
            }
        }

        function trimTrailingWhitespacesForLines(line1: number, line2: number, range?: TextRangeWithKind) {
            for (var line = line1; line < line2; ++line) {
                var lineStartPosition = getStartPositionOfLine(line, sourceFile);
                var lineEndPosition = getEndLinePosition(line, sourceFile);

                // do not trim whitespaces in comments
                if (range && isComment(range.kind) && range.pos <= lineEndPosition && range.end > lineEndPosition) {
                    continue;
                }

                var pos = lineEndPosition;
                while (pos >= lineStartPosition && isWhiteSpace(sourceFile.text.charCodeAt(pos))) {
                    pos--;
                }
                if (pos !== lineEndPosition) {
                    Debug.assert(pos === lineStartPosition || !isWhiteSpace(sourceFile.text.charCodeAt(pos)));
                    recordDelete(pos + 1, lineEndPosition - pos);
                }
            }
        }

        function newTextChange(start: number, len: number, newText: string): TextChange {
            return { span: new TypeScript.TextSpan(start, len), newText: newText }
        }

        function recordDelete(start: number, len: number) {
            if (len) {
                edits.push(newTextChange(start, len, ""));
            }
        }

        function recordReplace(start: number, len: number, newText: string) {
            if (len || newText) {
                edits.push(newTextChange(start, len, newText));
            }
        }

        function applyRuleEdits(rule: Rule,
            previousRange: TextRangeWithKind,
            previousStartLine: number,
            currentRange: TextRangeWithKind,
            currentStartLine: number): void {

            var between: TextRange;
            switch (rule.Operation.Action) {
                case RuleAction.Ignore:
                    // no action required
                    return;
                case RuleAction.Delete:
                    if (previousRange.end !== currentRange.pos) {
                        // delete characters starting from t1.end up to t2.pos exclusive
                        recordDelete(previousRange.end, currentRange.pos - previousRange.end);
                    }
                    break;
                case RuleAction.NewLine:
                    // exit early if we on different lines and rule cannot change number of newlines
                    // if line1 and line2 are on subsequent lines then no edits are required - ok to exit
                    // if line1 and line2 are separated with more than one newline - ok to exit since we cannot delete extra new lines
                    if (rule.Flag !== RuleFlags.CanDeleteNewLines && previousStartLine !== currentStartLine) {
                        return;
                    }

                    // edit should not be applied only if we have one line feed between elements
                    var lineDelta = currentStartLine - previousStartLine;
                    if (lineDelta !== 1) {
                        recordReplace(previousRange.end, currentRange.pos - previousRange.end, options.NewLineCharacter);
                    }
                    break;
                case RuleAction.Space:
                    // exit early if we on different lines and rule cannot change number of newlines
                    if (rule.Flag !== RuleFlags.CanDeleteNewLines && previousStartLine !== currentStartLine) {
                        return;
                    }

                    var posDelta = currentRange.pos - previousRange.end;
                    if (posDelta !== 1 || sourceFile.text.charCodeAt(previousRange.end) !== CharacterCodes.space) {
                        recordReplace(previousRange.end, currentRange.pos - previousRange.end, " ");
                    }
                    break;
            }
        }
    }

    function isSomeBlock(kind: SyntaxKind): boolean {
        switch (kind) {
            case SyntaxKind.Block:
            case SyntaxKind.FunctionBlock:
            case SyntaxKind.TryBlock:
            case SyntaxKind.CatchBlock:
            case SyntaxKind.FinallyBlock:
            case SyntaxKind.ModuleBlock:
                return true;
        }
        return false;
    }

    function getOpenTokenForList(node: Node, list: Node[]) {
        switch (node.kind) {
            case SyntaxKind.Constructor:
            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.FunctionExpression:
            case SyntaxKind.Method:
            case SyntaxKind.ArrowFunction:
                if ((<FunctionDeclaration>node).typeParameters === list) {
                    return SyntaxKind.LessThanToken;
                }
                else if ((<FunctionDeclaration>node).parameters === list) {
                    return SyntaxKind.OpenParenToken;
                }
                break;
            case SyntaxKind.CallExpression:
            case SyntaxKind.NewExpression:
                if ((<CallExpression>node).typeArguments === list) {
                    return SyntaxKind.LessThanToken;
                }
                else if ((<CallExpression>node).arguments === list) {
                    return SyntaxKind.OpenParenToken;
                }
                break;
            case SyntaxKind.TypeReference:
                if ((<TypeReferenceNode>node).typeArguments === list) {
                    return SyntaxKind.LessThanToken;
                }
        }

        return SyntaxKind.Unknown;
    }

    function getCloseTokenForOpenToken(kind: SyntaxKind) {
        switch (kind) {
            case SyntaxKind.OpenParenToken:
                return SyntaxKind.CloseParenToken;
            case SyntaxKind.LessThanToken:
                return SyntaxKind.GreaterThanToken;
        }

        return SyntaxKind.Unknown;
    }
}