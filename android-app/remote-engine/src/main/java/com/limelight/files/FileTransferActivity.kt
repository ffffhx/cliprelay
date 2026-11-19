package com.limelight.files

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.limelight.R
import com.limelight.nvstream.http.NvHTTP
import org.json.JSONObject
import java.util.concurrent.Executors

/** The screen observes snapshots; durable transfers remain owned by TransferService. */
class FileTransferActivity : ComponentActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var store: TransferStorage
    private lateinit var host: JSONObject
    private var http: NvHTTP? = null
    private var ui by mutableStateOf(FileTransferState())
    private var generation = 0
    private var pickerRoot = ""
    private var pickerPath = ""
    private var pendingDownloads = arrayListOf<String>()
    private val refreshQueue = object : Runnable {
        override fun run() { updateQueue(); main.postDelayed(this, 750) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            host = TransferStorage.host(intent)
            store = TransferStorage.get(this)
            http = TransferStorage.connection(this, host)
        } catch (_: Exception) {
            Toast.makeText(this, R.string.files_unpaired, Toast.LENGTH_LONG).show(); finish(); return
        }
        val saved = savedInstanceState
        pickerRoot = saved?.getString("pickerRoot").orEmpty()
        pickerPath = saved?.getString("pickerPath").orEmpty()
        pendingDownloads = saved?.getStringArrayList("pendingDownloads") ?: arrayListOf()
        ui = FileTransferState(hostName = host.optString("name").removePrefix("ClipRelay - "),
            root = saved?.getString("root").orEmpty(), path = saved?.getString("path").orEmpty(),
            selected = saved?.getStringArrayList("selected")?.toSet().orEmpty(),
            showQueue = saved?.getBoolean("showQueue") ?: false)
        enableEdgeToEdge()
        setContent { FileTransferTheme { FileTransferScreen(ui, ::act) } }
        loadRoots(then = { if (ui.root.isNotEmpty()) list(preserveSelection = true) })
    }

    private fun query(op: String) = JSONObject().put("op", op).put("root", ui.root).put("path", ui.path)

    private fun request(query: JSONObject, success: (JSONObject) -> Unit) {
        ui = ui.copy(loading = true, error = "", notice = "")
        val token = ++generation
        worker.execute {
            try {
                val result = requireNotNull(http).filesRequest(query)
                runOnUiThread {
                    if (!isDestroyed && token == generation) {
                        ui = ui.copy(loading = false, connected = true); success(result)
                    }
                }
            } catch (error: Exception) {
                runOnUiThread { if (!isDestroyed && token == generation) {
                    ui = ui.copy(loading = false, error = errorText(error.message),
                        connected = if (error.message == null || error.message?.startsWith("FILES_") != true) false else ui.connected)
                } }
            }
        }
    }

    private fun loadRoots(then: () -> Unit = {}) = request(query("roots")) { response ->
        val roots = response.optJSONArray("roots")
        ui = ui.copy(roots = (0 until (roots?.length() ?: 0)).mapNotNull {
            roots?.optJSONObject(it)?.optString("id")?.takeIf(String::isNotBlank)
        })
        then()
    }

    private fun list(append: Boolean = false, preserveSelection: Boolean = false) {
        if (ui.root.isEmpty()) { loadRoots(); return }
        if (!append) ui = ui.copy(entries = emptyList(), next = "", selected = if (preserveSelection) ui.selected else emptySet())
        request(query("list").put("after", if (append) ui.next else "")) { response ->
            val array = response.optJSONArray("entries")
            val loaded = (0 until (array?.length() ?: 0)).mapNotNull { i -> array?.optJSONObject(i)?.let {
                RemoteFile(it.optString("name"), it.optBoolean("directory"), it.optLong("size", -1), it.optBoolean("blocked"))
            } }
            val entries = ((if (append) ui.entries else emptyList()) + loaded).distinctBy { it.name }
            ui = ui.copy(entries = entries, next = response.optString("next"),
                selected = ui.selected.intersect(entries.filter { !it.directory && !it.blocked }.map { it.name }.toSet()))
        }
    }

    private fun act(action: FileAction) {
        when (action.kind) {
            FileActionKind.BACK -> finish()
            FileActionKind.SHOW_QUEUE -> ui = ui.copy(showQueue = true)
            FileActionKind.HIDE_QUEUE -> ui = ui.copy(showQueue = false)
            FileActionKind.CLEAR_SELECTION -> ui = ui.copy(selected = emptySet())
            FileActionKind.SELECT -> if (!ui.loading && ui.entries.any { it.name == action.value && !it.directory && !it.blocked })
                ui = ui.copy(selected = if (action.value in ui.selected) ui.selected - action.value else ui.selected + action.value)
            FileActionKind.SELECT_ALL -> if (!ui.loading) ui = ui.copy(selected = ui.entries.filter { !it.directory && !it.blocked }.map { it.name }.toSet())
            FileActionKind.OPEN_ROOT, FileActionKind.OPEN_PATH -> if (!ui.loading) {
                ui = ui.copy(root = if (action.kind == FileActionKind.OPEN_ROOT) action.value else ui.root,
                    path = if (action.kind == FileActionKind.OPEN_ROOT) "" else action.value)
                list()
            }
            FileActionKind.REFRESH -> if (!ui.loading) { if (ui.root.isEmpty()) loadRoots() else list() }
            FileActionKind.MORE -> if (!ui.loading && ui.next.isNotEmpty()) list(append = true)
            FileActionKind.MKDIR -> if (!ui.loading && ui.root.isNotEmpty()) request(query("mkdir").put("name", action.value)) { list() }
            FileActionKind.UPLOAD -> pickUpload()
            FileActionKind.DOWNLOAD -> pickDownload()
            FileActionKind.PAUSE_ALL -> jobs().filter { !it.terminal() && it.task.state != "paused" && !it.cancelRequested }.forEach { control(it, false) }
            FileActionKind.RESUME_ALL -> {
                jobs().filter { !it.terminal() && it.task.state == "paused" && !it.cancelRequested }.forEach { prepareResume(it) }
                startQueue()
            }
            else -> {
                val job = store.get(action.value)?.takeIf { TransferStorage.sameHost(host, it.host) } ?: return
                when (action.kind) {
                    FileActionKind.PAUSE -> control(job, false)
                    FileActionKind.CANCEL -> control(job, true)
                    FileActionKind.RESUME -> if (!job.terminal() && job.task.state == "paused") { prepareResume(job); startQueue() }
                    FileActionKind.FORGET -> try { store.forget(job) } catch (e: Exception) { showError(e) }
                    else -> Unit
                }
                updateQueue()
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun pickUpload() {
        if (ui.loading || ui.root.isEmpty()) return
        pickerRoot = ui.root; pickerPath = ui.path
        try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION), UPLOAD)
        } catch (_: ActivityNotFoundException) { ui = ui.copy(error = getString(R.string.files_picker_missing)) }
    }

    @Suppress("DEPRECATION")
    private fun pickDownload() {
        if (ui.loading || ui.root.isEmpty() || ui.selected.isEmpty()) return
        pickerRoot = ui.root; pickerPath = ui.path; pendingDownloads = ArrayList(ui.selected)
        try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION), DOWNLOAD)
        } catch (_: ActivityNotFoundException) { ui = ui.copy(error = getString(R.string.files_picker_missing)) }
    }

    @Deprecated("Uses persisted picker context for SAF results")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != Activity.RESULT_OK || data == null || requestCode !in listOf(UPLOAD, DOWNLOAD)) return
        val uris = data.clipData?.let { clips -> (0 until clips.itemCount).map { clips.getItemAt(it).uri } }
            ?: listOfNotNull(data.data)
        if (uris.isEmpty()) return
        val targetRoot = pickerRoot; val targetPath = pickerPath; val names = pendingDownloads.toList()
        ui = ui.copy(loading = true, error = "", notice = "")
        worker.execute {
            var failure: String? = null; var added = 0
            try {
                for (uri in uris) {
                    val permissions = Intent.FLAG_GRANT_READ_URI_PERMISSION or (if (requestCode == DOWNLOAD) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
                    contentResolver.takePersistableUriPermission(uri, permissions)
                    if (requestCode == UPLOAD) {
                        val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                            if (it.moveToFirst()) it.getString(0) else null
                        }?.takeIf(String::isNotBlank) ?: throw java.io.IOException("FILES_SOURCE_CHANGED")
                        store.add(TransferStorage.Job(TransferRunner.Task(TransferStorage.id(), "upload", targetRoot, targetPath, name), host)
                            .apply { source = uri.toString() }); added++
                    } else for (name in names) {
                        store.add(TransferStorage.Job(TransferRunner.Task(TransferStorage.id(), "download", targetRoot, targetPath, name), host)
                            .apply { tree = uri.toString() }); added++
                    }
                }
            } catch (e: Exception) { failure = errorText(e.message) }
            // Queue persistence and startup must also succeed if the picker activity was recreated.
            if (added > 0) try { TransferService.start(applicationContext) } catch (_: RuntimeException) {
                pauseQueued(); failure = getString(R.string.files_start_failed)
            }
            runOnUiThread { if (!isDestroyed) {
                ui = ui.copy(loading = false, error = failure.orEmpty(), notice = if (failure == null) getString(R.string.files_added, added) else "",
                    selected = if (added > 0 && failure == null && requestCode == DOWNLOAD) emptySet() else ui.selected, showQueue = added > 0 || ui.showQueue)
                updateQueue()
            } }
        }
    }

    private fun jobs() = store.jobs().filter { TransferStorage.sameHost(host, it.host) }
    private fun pauseQueued() { jobs().filter { it.task.state == "queued" }.forEach { job ->
        synchronized(store) { job.task.state = "paused"; runCatching { store.save(job) } }
    } }
    private fun startQueue() {
        try { TransferService.start(this) } catch (_: RuntimeException) { pauseQueued(); ui = ui.copy(error = getString(R.string.files_start_failed)) }
        updateQueue()
    }
    private fun control(job: TransferStorage.Job, cancel: Boolean) {
        try { TransferService.control(this, job, cancel) } catch (e: Exception) { showError(e) }
        updateQueue()
    }
    private fun prepareResume(job: TransferStorage.Job) {
        try { synchronized(store) { job.host = host; job.error = ""; job.task.state = if (job.cancelRequested) "cancelling" else "queued"; store.save(job) } }
        catch (e: Exception) { job.task.state = "paused"; showError(e) }
    }
    private fun showError(e: Exception) { ui = ui.copy(error = errorText(e.message)) }
    private fun updateQueue() {
        if (!::store.isInitialized) return
        ui = ui.copy(jobs = jobs().asReversed().map { job ->
            val task = job.task
            val name = if (task.state == "complete") (if (task.direction == "upload") task.finalName else job.finalName).ifEmpty { task.name } else task.name
            val destination = if (task.direction == "upload") listOf(ui.hostName, getString(fileRootLabel(task.root)), task.path).filter(String::isNotEmpty).joinToString(" / ")
                else runCatching { DocumentsContract.getTreeDocumentId(android.net.Uri.parse(job.tree)).substringAfter(':').replace('/', '／') }.getOrDefault("")
            TransferItem(task.id, name, task.direction, task.state, task.size,
                if (task.state in listOf("hashing", "verifying", "saving")) task.verified else task.offset,
                destination, if (job.error.isEmpty()) "" else errorText(job.error), job.cancelRequested)
        })
    }

    private fun errorText(code: String?) = getString(when (code) {
        "UPDATE_HOST" -> R.string.files_update_host
        "FILES_UNPAIRED" -> R.string.files_unpaired
        "FILES_DISK_FULL" -> R.string.files_disk_full
        "FILES_HASH_MISMATCH", "FILES_SOURCE_CHANGED", "FILES_CHUNK_CONFLICT" -> R.string.files_changed
        "FILES_LINK_NOT_ALLOWED" -> R.string.files_link
        "FILES_BAD_PATH", "FILES_BAD_REQUEST" -> R.string.files_bad_path
        "FILES_QUEUE_FULL" -> R.string.files_queue_full
        "FILES_CANCEL_PENDING" -> R.string.files_cancel_pending
        "FILES_INTERRUPTED", "FILES_PAUSED" -> R.string.files_interrupted
        "FILES_RENAME_UNSUPPORTED", "FILES_DESTINATION", "FILES_DESTINATION_CHANGED" -> R.string.files_destination_error
        "FILES_ACCESS_DENIED" -> R.string.files_access_denied
        else -> R.string.files_connection
    })

    override fun onResume() { super.onResume(); if (::store.isInitialized) main.post(refreshQueue) }
    override fun onPause() { main.removeCallbacks(refreshQueue); super.onPause() }
    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        out.putString("root", ui.root); out.putString("path", ui.path); out.putStringArrayList("selected", ArrayList(ui.selected))
        out.putBoolean("showQueue", ui.showQueue); out.putString("pickerRoot", pickerRoot); out.putString("pickerPath", pickerPath)
        out.putStringArrayList("pendingDownloads", pendingDownloads)
    }
    override fun onDestroy() { generation++; http?.cancelFilesRequest(); worker.shutdown(); main.removeCallbacks(refreshQueue); super.onDestroy() }
    companion object { private const val UPLOAD = 91; private const val DOWNLOAD = 92 }
}
