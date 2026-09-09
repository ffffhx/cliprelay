package com.cliprelay.app.ui

import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.ast.ASTNode

private val blankLine = Regex("\n[ \\t]*\n")

/** Only direct block boundaries count; blank lines inside nested blocks do not loosen the outer list. */
internal fun needsParagraphGap(content: String, paragraph: ASTNode): Boolean {
    val item = paragraph.parent ?: return true
    if (item.type != MarkdownElementTypes.LIST_ITEM) return true
    val list = item.parent ?: return true
    val items = list.children.filter { it.type == MarkdownElementTypes.LIST_ITEM }
    fun blocks(node: ASTNode) = node.children.filter {
        it.type != MarkdownTokenTypes.EOL && it.type != MarkdownTokenTypes.WHITE_SPACE &&
            it.type != MarkdownTokenTypes.LIST_BULLET && it.type != MarkdownTokenTypes.LIST_NUMBER
    }
    fun separated(left: ASTNode, right: ASTNode) =
        blankLine.containsMatchIn(content.substring(left.endOffset, right.startOffset))
    return items.zipWithNext().any { (left, right) ->
        val lastBlock = blocks(left).lastOrNull()
        lastBlock != null && separated(lastBlock, right)
    } || items.any { entry -> blocks(entry).zipWithNext().any { (left, right) -> separated(left, right) } }
}
