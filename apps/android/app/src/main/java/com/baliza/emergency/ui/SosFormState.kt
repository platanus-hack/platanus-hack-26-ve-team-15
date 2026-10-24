package com.baliza.emergency.ui

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.toMutableStateList

/**
 * What the user has chosen on the SOS screen. It lives above the screen so that visiting another screen
 * (the debug panel) and coming back does not reset it: a reset used to re-select every contact, which could
 * alert someone the user had deliberately left out.
 */
@Stable
class SosFormState(
    category: Int = 1,
    severity: Int = 3,
    publicText: String = "",
    note: String = "",
    selected: Collection<Int> = emptyList(),
    known: Collection<Int> = emptyList()
) {
    var category by mutableStateOf(category)
    var severity by mutableStateOf(severity)
    var publicText by mutableStateOf(publicText)
    var note by mutableStateOf(note)
    val selected: SnapshotStateList<Int> = selected.toMutableStateList()

    /** Contacts this form has already seen, to tell a contact the user unticked from one that is new. */
    private var known: Set<Int> = known.toSet()

    /**
     * Adapts the selection to the current contact list. A contact seen for the first time starts selected (in
     * an emergency the default is to tell everyone); one the user unticked stays unticked; one that no
     * longer exists is dropped.
     */
    fun reconcile(contactIndexes: Collection<Int>) {
        val now = contactIndexes.toSet()
        selected.retainAll(now)
        for (index in contactIndexes) if (index !in known && index !in selected) selected.add(index)
        known = now
    }

    fun toggle(index: Int) {
        if (index in selected) selected.remove(index) else selected.add(index)
    }

    companion object {
        val Saver: Saver<SosFormState, Any> = listSaver(
            save = {
                listOf(it.category, it.severity, it.publicText, it.note, ArrayList(it.selected), ArrayList(it.known))
            },
            restore = {
                @Suppress("UNCHECKED_CAST")
                SosFormState(
                    category = it[0] as Int, severity = it[1] as Int, publicText = it[2] as String, note = it[3] as String,
                    selected = it[4] as List<Int>, known = it[5] as List<Int>
                )
            }
        )
    }
}
