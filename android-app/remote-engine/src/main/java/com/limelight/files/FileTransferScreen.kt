package com.limelight.files

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.limelight.R
import java.util.Locale

data class RemoteFile(val name: String, val directory: Boolean = false, val size: Long = -1, val blocked: Boolean = false)
data class TransferItem(val id: String, val name: String, val direction: String, val state: String,
    val size: Long = -1, val bytes: Long = 0, val destination: String = "", val error: String = "", val cancelRequested: Boolean = false) {
    val terminal get() = state == "complete" || state == "cancelled"
    val progress get() = if (state == "complete") 1f else if (size > 0) (bytes.toDouble() / size).toFloat().coerceIn(0f, 1f) else 0f
    val canPause get() = !terminal && !cancelRequested && state !in listOf("paused", "pausing", "cancelling")
}
data class FileTransferState(val hostName: String = "", val root: String = "", val path: String = "", val roots: List<String> = emptyList(),
    val entries: List<RemoteFile> = emptyList(), val selected: Set<String> = emptySet(), val next: String = "", val loading: Boolean = false,
    val connected: Boolean? = null, val error: String = "", val notice: String = "", val jobs: List<TransferItem> = emptyList(), val showQueue: Boolean = false) {
    val selectionSize get() = entries.filter { it.name in selected }.sumOf { it.size.coerceAtLeast(0) }
}
enum class FileActionKind { BACK, OPEN_ROOT, OPEN_PATH, SELECT, SELECT_ALL, CLEAR_SELECTION, REFRESH, MORE, MKDIR, UPLOAD, DOWNLOAD,
    SHOW_QUEUE, HIDE_QUEUE, PAUSE, RESUME, CANCEL, FORGET, PAUSE_ALL, RESUME_ALL }
data class FileAction(val kind: FileActionKind, val value: String = "")

fun fileRootLabel(root: String) = when (root) {
    "home" -> R.string.files_home; "desktop" -> R.string.files_desktop; "documents" -> R.string.files_documents
    "downloads" -> R.string.files_downloads; else -> R.string.ft_computer
}
fun fileSize(bytes: Long): String {
    if (bytes < 0) return "—"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var value = bytes.toDouble(); var unit = 0
    while (value >= 1024 && unit < units.lastIndex) { value /= 1024; unit++ }
    return String.format(Locale.getDefault(), if (unit == 0) "%.0f %s" else "%.1f %s", value, units[unit])
}

@Composable fun FileTransferTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (dark) darkColorScheme(primary = Color(0xFF7AB7FF), onPrimary = Color(0xFF002D52),
        surface = Color(0xFF20252F), onSurface = Color(0xFFE8F1FA), background = Color(0xFF181C24),
        surfaceVariant = Color(0xFF2A303C), onSurfaceVariant = Color(0xFFB8C8D8), outline = Color(0xFF50677A),
        secondaryContainer = Color(0xFF243B5E), error = Color(0xFFFFB4AB))
    else lightColorScheme(primary = Color(0xFF3F5ED7), onPrimary = Color.White, surface = Color.White,
        onSurface = Color(0xFF202633), background = Color(0xFFF7F8FA), surfaceVariant = Color(0xFFF1F3F7),
        onSurfaceVariant = Color(0xFF737C8B), outline = Color(0xFFDDE2EA), secondaryContainer = Color(0xFFEBEFFF), error = Color(0xFFB42318))
    MaterialTheme(colorScheme = colors, content = content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun FileTransferScreen(state: FileTransferState, onAction: (FileAction) -> Unit) {
    var rootsOpen by rememberSaveable { mutableStateOf(false) }
    var newFolder by rememberSaveable { mutableStateOf(false) }
    var folderName by rememberSaveable { mutableStateOf("") }
    var cancelId by rememberSaveable { mutableStateOf<String?>(null) }
    val selected = state.selected.isNotEmpty()
    val fileListState = rememberLazyListState()
    LaunchedEffect(state.root, state.path) { fileListState.scrollToItem(0) }
    fun act(kind: FileActionKind, value: String = "") = onAction(FileAction(kind, value))
    BackHandler(!state.showQueue && !rootsOpen && !newFolder && cancelId == null) {
        if (selected) act(FileActionKind.CLEAR_SELECTION)
        else if (state.path.isNotEmpty()) act(FileActionKind.OPEN_PATH, state.path.substringBeforeLast('/', ""))
        else act(FileActionKind.BACK)
    }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().testTag("file-transfer-screen")) {
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 8.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                FileIconButton(if (selected) FileGlyph.CLOSE else FileGlyph.BACK,
                    stringResource(if (selected) R.string.ft_clear_selection else R.string.files_back), "files-back") {
                    act(if (selected) FileActionKind.CLEAR_SELECTION else FileActionKind.BACK)
                }
                Column(Modifier.weight(1f).padding(start = 4.dp)) {
                    Text(if (selected) stringResource(R.string.ft_selected_title, state.selected.size) else stringResource(R.string.files_title),
                        fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(4.dp))
                    Text(if (selected) stringResource(R.string.ft_selection_subtitle, fileSize(state.selectionSize), state.hostName)
                        else state.hostName + "  ·  " + stringResource(when (state.connected) { true -> R.string.ft_online; false -> R.string.ft_disconnected; null -> R.string.ft_connecting }),
                        fontSize = 11.sp, lineHeight = 15.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (selected) TextButton(onClick = { act(FileActionKind.SELECT_ALL) }, enabled = !state.loading, modifier = Modifier.testTag("files-select-all")) {
                    Text(stringResource(R.string.ft_select_all), fontSize = 13.sp, lineHeight = 18.sp)
                } else Box {
                    FileIconButton(FileGlyph.TRANSFER, stringResource(R.string.ft_tasks), "files-open-queue", tint = MaterialTheme.colorScheme.primary) { act(FileActionKind.SHOW_QUEUE) }
                    val count = state.jobs.count { !it.terminal }
                    if (count > 0) Badge(Modifier.align(Alignment.TopEnd).padding(3.dp), containerColor = MaterialTheme.colorScheme.primary) { Text(count.toString()) }
                }
            }
            Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { rootsOpen = true }, enabled = !state.loading, modifier = Modifier.testTag("files-roots"), contentPadding = PaddingValues(horizontal = 6.dp)) {
                    FileIcon(FileGlyph.COMPUTER, Modifier.size(16.dp)); Spacer(Modifier.width(5.dp)); Text(stringResource(R.string.ft_computer), fontSize = 12.sp, lineHeight = 17.sp)
                }
                if (state.root.isNotEmpty()) {
                    Crumb(stringResource(fileRootLabel(state.root)), state.path.isEmpty(), !state.loading) { act(FileActionKind.OPEN_PATH, "") }
                    val segments = state.path.split('/').filter(String::isNotEmpty)
                    segments.forEachIndexed { index, name -> Crumb(name, index == segments.lastIndex, !state.loading) {
                        act(FileActionKind.OPEN_PATH, segments.take(index + 1).joinToString("/"))
                    } }
                }
            }
            if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp)) else HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = .35f))
            LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("files-list"), state = fileListState, contentPadding = PaddingValues(20.dp, 16.dp, 20.dp, 18.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                item {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(if (state.root.isEmpty()) stringResource(R.string.ft_roots_title) else state.path.substringAfterLast('/').ifEmpty { stringResource(fileRootLabel(state.root)) },
                            Modifier.weight(1f), fontSize = 19.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (state.root.isNotEmpty()) Text(stringResource(R.string.ft_item_count, state.entries.size), fontSize = 11.sp, lineHeight = 15.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (state.root.isNotEmpty()) FileIconButton(FileGlyph.RETRY, stringResource(R.string.ft_refresh), "files-refresh", enabled = !state.loading) { act(FileActionKind.REFRESH) }
                        if (state.root.isNotEmpty()) TextButton(onClick = { folderName = ""; newFolder = true }, enabled = !state.loading, modifier = Modifier.testTag("files-mkdir"), contentPadding = PaddingValues(start = 12.dp)) {
                            FileIcon(FileGlyph.NEW_FOLDER, Modifier.size(18.dp)); Spacer(Modifier.width(5.dp)); Text(stringResource(R.string.ft_new), fontSize = 12.sp, lineHeight = 17.sp)
                        }
                    }
                    Text(stringResource(if (state.root.isEmpty()) R.string.ft_choose_location else if (selected) R.string.ft_selected_hint else R.string.ft_select_hint),
                        fontSize = 12.sp, lineHeight = 17.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp, bottom = 18.dp))
                }
                if (state.error.isNotEmpty()) item { ErrorNotice(state.error, !state.loading) { act(FileActionKind.REFRESH) } }
                if (state.notice.isNotEmpty()) item { Text(state.notice, fontSize = 12.sp, lineHeight = 17.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(bottom = 12.dp)) }
                if (state.root.isEmpty()) items(state.roots, key = { it }) { root -> RootRow(root, !state.loading) { act(FileActionKind.OPEN_ROOT, root) } }
                else {
                    items(state.entries, key = { it.name }) { file ->
                        FileRow(file, file.name in state.selected, !state.loading) {
                            act(if (file.directory) FileActionKind.OPEN_PATH else FileActionKind.SELECT,
                                if (file.directory) listOf(state.path, file.name).filter(String::isNotEmpty).joinToString("/") else file.name)
                        }
                    }
                    if (!state.loading && state.error.isEmpty() && state.entries.isEmpty()) item {
                        EmptyFiles(R.string.ft_empty_folder, R.string.ft_empty_folder_hint)
                    }
                    if (state.next.isNotEmpty()) item { TextButton(onClick = { act(FileActionKind.MORE) }, enabled = !state.loading, modifier = Modifier.fillMaxWidth().testTag("files-more")) { Text(stringResource(R.string.files_more)) } }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = .35f))
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (state.jobs.isNotEmpty()) QueueSummary(state.jobs) { act(FileActionKind.SHOW_QUEUE) }
                if (selected) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(stringResource(R.string.ft_selected_count, state.selected.size), fontSize = 12.sp, lineHeight = 17.sp)
                    Text(fileSize(state.selectionSize), fontSize = 12.sp, lineHeight = 17.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Button(onClick = { act(if (selected) FileActionKind.DOWNLOAD else FileActionKind.UPLOAD) },
                    enabled = !state.loading && state.root.isNotEmpty(), shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag(if (selected) "files-download" else "files-upload")) {
                    FileIcon(if (selected) FileGlyph.DOWNLOAD else FileGlyph.UPLOAD, Modifier.size(21.dp))
                    Spacer(Modifier.width(10.dp)); Text(stringResource(if (selected) R.string.ft_download else R.string.ft_upload), fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
                }
                Text(if (selected) stringResource(R.string.ft_download_destination) else if (state.root.isEmpty()) stringResource(R.string.ft_choose_location)
                    else stringResource(R.string.ft_upload_destination, listOf(state.hostName, stringResource(fileRootLabel(state.root)), state.path).filter(String::isNotEmpty).joinToString(" / ")),
                    fontSize = 10.sp, lineHeight = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.align(Alignment.CenterHorizontally))
            }
        }
    }
    if (rootsOpen) ModalBottomSheet(onDismissRequest = { rootsOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).verticalScroll(rememberScrollState()).padding(bottom = 20.dp).testTag("files-roots-sheet")) {
            SheetHeading(stringResource(R.string.ft_roots_title), stringResource(R.string.ft_roots_subtitle, state.hostName)) { rootsOpen = false }
            if (state.roots.isEmpty()) TextButton(onClick = { act(FileActionKind.REFRESH) }, enabled = !state.loading) { Text(stringResource(R.string.ft_retry)) }
            state.roots.forEach { root -> RootRow(root, !state.loading) { rootsOpen = false; act(FileActionKind.OPEN_ROOT, root) } }
        }
    }
    if (state.showQueue) TransferSheet(state, onAction, onCancel = { cancelId = it })
    if (newFolder) AlertDialog(onDismissRequest = { newFolder = false }, title = { Text(stringResource(R.string.files_new_folder)) },
        text = { Column { Text(stringResource(R.string.ft_current_folder, state.path.ifEmpty { stringResource(fileRootLabel(state.root)) }), fontSize = 12.sp, lineHeight = 17.sp)
            Spacer(Modifier.height(12.dp)); OutlinedTextField(folderName, { folderName = it }, singleLine = true, label = { Text(stringResource(R.string.ft_folder_name)) }, modifier = Modifier.testTag("files-folder-name")) } },
        confirmButton = { TextButton(onClick = { newFolder = false; act(FileActionKind.MKDIR, folderName.trim()) },
            enabled = !state.loading && validFolderName(folderName), modifier = Modifier.testTag("files-folder-create")) { Text(stringResource(R.string.ft_create)) } },
        dismissButton = { TextButton(onClick = { newFolder = false }) { Text(stringResource(android.R.string.cancel)) } })
    cancelId?.let { id ->
        val job = state.jobs.find { it.id == id }
        AlertDialog(onDismissRequest = { cancelId = null }, modifier = Modifier.testTag("files-cancel-dialog"),
            title = { Text(stringResource(R.string.ft_cancel_title)) },
            text = { Text((job?.name.orEmpty()) + "\n\n" + stringResource(R.string.ft_cancel_message)) },
            confirmButton = { TextButton(onClick = { cancelId = null; act(FileActionKind.CANCEL, id) }, enabled = job != null && !job.terminal,
                modifier = Modifier.testTag("files-confirm-cancel")) { Text(stringResource(R.string.files_cancel), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { cancelId = null }, modifier = Modifier.testTag("files-keep-transfer")) { Text(stringResource(R.string.ft_keep)) } })
    }
}

fun validFolderName(value: String) = value.trim().let { it.isNotEmpty() && it != "." && it != ".." && it.length <= 255 && it.none { c -> c in "/\\:*?\"<>|" || c.code < 32 } }

@Composable private fun Crumb(text: String, current: Boolean, enabled: Boolean, click: () -> Unit) {
    FileIcon(FileGlyph.NEXT, Modifier.size(12.dp), MaterialTheme.colorScheme.onSurfaceVariant)
    TextButton(onClick = click, enabled = enabled, contentPadding = PaddingValues(horizontal = 8.dp)) {
        Text(text, fontSize = 12.sp, lineHeight = 17.sp, color = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
}
@Composable private fun RootRow(root: String, enabled: Boolean, click: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).clickable(enabled = enabled, onClick = click).padding(12.dp).heightIn(min = 44.dp).testTag("files-root-$root"), verticalAlignment = Alignment.CenterVertically) {
        FileTypeIcon("", directory = true); Text(stringResource(fileRootLabel(root)), Modifier.weight(1f).padding(horizontal = 14.dp), fontSize = 15.sp, lineHeight = 21.sp)
        FileIcon(FileGlyph.NEXT, Modifier.size(17.dp), MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
@Composable private fun FileRow(file: RemoteFile, checked: Boolean, enabled: Boolean, click: () -> Unit) {
    val description = stringResource(if (file.blocked) R.string.ft_blocked else if (file.directory) R.string.ft_folder else R.string.ft_file)
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(if (checked) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
        .clickable(enabled = enabled && !file.blocked, role = if (file.directory) Role.Button else Role.Checkbox, onClick = click)
        .semantics { if (!file.directory) selected = checked; stateDescription = description }
        .testTag("file-${file.name}").padding(horizontal = 10.dp, vertical = 10.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
        FileTypeIcon(file.name, file.directory)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(file.name, fontSize = 14.sp, lineHeight = 20.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, color = if (file.blocked) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
            Spacer(Modifier.height(4.dp))
            Text(if (file.blocked || file.directory) description else file.name.substringAfterLast('.', "").uppercase(Locale.ROOT).ifEmpty { stringResource(R.string.ft_file) } + " · " + fileSize(file.size),
                fontSize = 11.sp, lineHeight = 15.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (file.directory) FileIcon(FileGlyph.NEXT, Modifier.size(16.dp), MaterialTheme.colorScheme.onSurfaceVariant)
        else Box(Modifier.size(20.dp).clip(RoundedCornerShape(6.dp)).background(if (checked) MaterialTheme.colorScheme.primary else Color.Transparent)
            .border(1.dp, if (checked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline, RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
            if (checked) FileIcon(FileGlyph.CHECK, Modifier.size(16.dp), MaterialTheme.colorScheme.onPrimary)
        }
    }
}
@Composable private fun EmptyFiles(title: Int, hint: Int) {
    Column(Modifier.fillMaxWidth().padding(vertical = 46.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        FileIcon(FileGlyph.FOLDER, Modifier.size(38.dp), MaterialTheme.colorScheme.onSurfaceVariant)
        Text(stringResource(title), fontSize = 15.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 16.dp, bottom = 8.dp))
        Text(stringResource(hint), fontSize = 12.sp, lineHeight = 17.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
@Composable private fun ErrorNotice(message: String, retryEnabled: Boolean, retry: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.error.copy(alpha = .07f), RoundedCornerShape(12.dp)).padding(12.dp).testTag("files-error")) {
        Text(message, color = MaterialTheme.colorScheme.error, fontSize = 12.sp, lineHeight = 17.sp)
        TextButton(onClick = retry, enabled = retryEnabled) { Text(stringResource(R.string.ft_retry)) }
    }
}
@Composable private fun QueueSummary(jobs: List<TransferItem>, click: () -> Unit) {
    val active = jobs.filter { !it.terminal }
    val allPaused = active.isNotEmpty() && active.all { it.state == "paused" }
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(13.dp)).background(MaterialTheme.colorScheme.surfaceVariant)
        .clickable(onClick = click).testTag("files-queue-summary").padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
        FileIcon(FileGlyph.TRANSFER, Modifier.size(22.dp), MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(if (active.isEmpty()) stringResource(R.string.ft_history) else stringResource(if (allPaused) R.string.ft_paused_count else R.string.ft_active_count, active.size), fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.SemiBold)
            Text(stringResource(R.string.ft_queue_hint), fontSize = 10.sp, lineHeight = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 3.dp))
        }
        if (active.isNotEmpty()) LinearProgressIndicator(progress = { active.map { it.progress }.average().toFloat() }, modifier = Modifier.width(32.dp).height(3.dp), drawStopIndicator = {})
        Spacer(Modifier.width(12.dp)); FileIcon(FileGlyph.NEXT, Modifier.size(14.dp), MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun TransferSheet(state: FileTransferState, onAction: (FileAction) -> Unit, onCancel: (String) -> Unit) {
    var history by rememberSaveable { mutableStateOf(state.jobs.isNotEmpty() && state.jobs.all { it.terminal }) }
    val active = state.jobs.filter { !it.terminal }; val finished = state.jobs.filter { it.terminal }
    LaunchedEffect(active.isEmpty(), finished.size) { if (active.isEmpty() && finished.isNotEmpty()) history = true }
    val shown = if (history) finished else active
    val allPaused = active.isNotEmpty() && active.all { it.state == "paused" }
    ModalBottomSheet(onDismissRequest = { onAction(FileAction(FileActionKind.HIDE_QUEUE)) }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)) {
        Column(Modifier.fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * .82f).dp).padding(horizontal = 20.dp).testTag("files-queue-sheet")) {
            SheetHeading(stringResource(R.string.ft_tasks), stringResource(R.string.ft_tasks_subtitle, state.hostName)) { onAction(FileAction(FileActionKind.HIDE_QUEUE)) }
            Row(Modifier.fillMaxWidth().padding(top = 12.dp)) {
                listOf(false to R.string.ft_active, true to R.string.ft_history).forEach { (tab, label) ->
                    Column(Modifier.padding(end = 20.dp).clickable { history = tab }.semantics { selected = history == tab }.testTag(if (tab) "files-history-tab" else "files-active-tab")) {
                        Text(stringResource(label) + "  " + (if (tab) finished.size else active.size), fontSize = 13.sp, lineHeight = 18.sp,
                            fontWeight = if (history == tab) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (history == tab) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 14.dp))
                        if (history == tab) Box(Modifier.width(74.dp).height(2.dp).background(MaterialTheme.colorScheme.primary)) else Spacer(Modifier.height(2.dp))
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = .4f))
            LazyColumn(Modifier.weight(1f, fill = false).testTag("files-task-list"), contentPadding = PaddingValues(vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (state.error.isNotEmpty()) item { Text(state.error, color = MaterialTheme.colorScheme.error, fontSize = 12.sp, lineHeight = 17.sp) }
                if (shown.isEmpty()) item { EmptyFiles(if (history) R.string.ft_no_history else R.string.files_empty, R.string.ft_no_tasks_hint) }
                items(shown, key = { it.id }) { job -> TransferCard(job, onAction, onCancel) }
            }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(if (history) R.string.ft_history_hint else R.string.ft_background_hint), Modifier.weight(1f).padding(end = 10.dp), fontSize = 11.sp, lineHeight = 15.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (!history && active.isNotEmpty()) FilledTonalButton(onClick = { onAction(FileAction(if (allPaused) FileActionKind.RESUME_ALL else FileActionKind.PAUSE_ALL)) },
                    enabled = active.any { if (allPaused) !it.cancelRequested else it.canPause }, shape = RoundedCornerShape(12.dp), modifier = Modifier.testTag("files-control-all"),
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                    FileIcon(if (allPaused) FileGlyph.PLAY else FileGlyph.PAUSE, Modifier.size(15.dp)); Spacer(Modifier.width(6.dp))
                    Text(stringResource(if (allPaused) R.string.ft_resume_all else R.string.files_pause_all), fontSize = 12.sp, lineHeight = 17.sp)
                }
            }
        }
    }
}
@Composable private fun SheetHeading(title: String, subtitle: String, close: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 21.sp, lineHeight = 27.sp, fontWeight = FontWeight.SemiBold)
            Text(subtitle, fontSize = 12.sp, lineHeight = 17.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 5.dp))
        }
        FileIconButton(FileGlyph.CLOSE, stringResource(R.string.ft_close), "files-sheet-close", click = close)
    }
}
@Composable private fun TransferCard(job: TransferItem, onAction: (FileAction) -> Unit, onCancel: (String) -> Unit) {
    val upload = job.direction == "upload"
    val stateLabel = stringResource(when (job.state) {
        "queued" -> R.string.files_queued; "hashing", "verifying" -> R.string.files_verifying; "receiving" -> R.string.files_receiving
        "sending" -> R.string.files_sending; "saving", "ready-to-save" -> R.string.files_saving; "complete" -> R.string.files_complete
        "cancelled" -> R.string.files_cancelled; "cancelling" -> R.string.files_cancelling; "pausing" -> R.string.files_pausing; else -> R.string.files_paused
    })
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(MaterialTheme.colorScheme.background)
        .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .35f), RoundedCornerShape(17.dp)).padding(14.dp).testTag("transfer-${job.id}")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            FileTypeIcon(job.name, small = true)
            Column(Modifier.weight(1f).padding(start = 10.dp)) {
                Text(job.name, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, lineHeight = 18.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(stringResource(if (upload) R.string.ft_to_computer else R.string.ft_to_phone), fontSize = 10.sp, lineHeight = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            }
            if (job.terminal) FileIconButton(FileGlyph.CLOSE, stringResource(R.string.files_clear), "transfer-clear-${job.id}") { onAction(FileAction(FileActionKind.FORGET, job.id)) }
            else {
                if (job.state == "paused") FileIconButton(if (job.cancelRequested) FileGlyph.RETRY else FileGlyph.PLAY,
                    stringResource(if (job.cancelRequested) R.string.files_retry_cancel else R.string.files_resume), "transfer-resume-${job.id}") { onAction(FileAction(FileActionKind.RESUME, job.id)) }
                else FileIconButton(FileGlyph.PAUSE, stringResource(R.string.files_pause), "transfer-pause-${job.id}", enabled = job.canPause) { onAction(FileAction(FileActionKind.PAUSE, job.id)) }
                FileIconButton(FileGlyph.CLOSE, stringResource(R.string.files_cancel), "transfer-cancel-${job.id}", enabled = !job.cancelRequested && job.state != "cancelling") { onCancel(job.id) }
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(stateLabel + (if (job.size > 0 && !job.terminal) " · ${(job.progress * 100).toInt()}%" else ""), fontSize = 11.sp, lineHeight = 15.sp,
                color = if (job.state == "paused" || job.state == "cancelled") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
            Text(fileSize(job.bytes) + " / " + fileSize(job.size), fontSize = 10.sp, lineHeight = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(9.dp))
        if (job.size < 0 && job.canPause && job.state != "queued") LinearProgressIndicator(Modifier.fillMaxWidth().height(4.dp))
        else LinearProgressIndicator(progress = { job.progress }, modifier = Modifier.fillMaxWidth().height(4.dp), drawStopIndicator = {})
        Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            FileIcon(if (upload) FileGlyph.COMPUTER else FileGlyph.PHONE, Modifier.size(13.dp), MaterialTheme.colorScheme.onSurfaceVariant)
            Text((if (upload) "" else stringResource(R.string.ft_phone) + " / ") + job.destination.ifEmpty { stringResource(R.string.ft_chosen_folder) },
                modifier = Modifier.padding(start = 5.dp), fontSize = 10.sp, lineHeight = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (job.error.isNotEmpty()) Text(job.error, fontSize = 11.sp, lineHeight = 15.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 10.dp))
    }
}
