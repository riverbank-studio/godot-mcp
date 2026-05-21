## HUD overlay that displays the player's inventory.
##
## Binds to a Player node and updates its label children whenever
## the inventory changes.  Used as the largest-file symbol-list target.
class_name InventoryUI
extends Control

# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------

## Emitted when an item row is clicked.
signal item_selected(item_name: String)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

const ROW_HEIGHT: int = 32
const MAX_ROWS: int = 8

# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------

## The player whose inventory is displayed.
var player: Player = null

## Current page offset (0-based) for the scrollable list.
var page_offset: int = 0

## Internal cache of item rows: item_name → Label node.
var _row_cache: Dictionary = {}

# ---------------------------------------------------------------------------
# @onready references
# ---------------------------------------------------------------------------

@onready var _container: VBoxContainer = $VBoxContainer
@onready var _page_label: Label = $PageLabel

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

func _ready() -> void:
	_rebuild_rows()


# ---------------------------------------------------------------------------
# Binding
# ---------------------------------------------------------------------------

## Bind to `p`; disconnects the previous player if any.
func bind_player(p: Player) -> void:
	if player != null:
		_disconnect_player(player)
	player = p
	if player != null:
		_connect_player(player)
	_rebuild_rows()


## Connect inventory-change signals on `p`.
func _connect_player(p: Player) -> void:
	# Player has no inventory_changed signal in v1; poll on _process instead.
	pass


## Disconnect signals on `p`.
func _disconnect_player(p: Player) -> void:
	pass


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

## Rebuild the visible label rows from player.inventory.
func _rebuild_rows() -> void:
	for child in _container.get_children():
		child.queue_free()
	_row_cache.clear()

	if player == null:
		return

	var items: Array = player.inventory.keys()
	var start: int = page_offset * MAX_ROWS
	var end: int = mini(start + MAX_ROWS, items.size())

	for i in range(start, end):
		var item_name: String = items[i]
		var qty: int = player.inventory.get(item_name, 0)
		var row: Label = _make_row(item_name, qty)
		_container.add_child(row)
		_row_cache[item_name] = row

	_page_label.text = "Page %d / %d" % [
		page_offset + 1,
		ceili(float(items.size()) / float(MAX_ROWS))
	]


## Create a single item-row Label.
func _make_row(item_name: String, qty: int) -> Label:
	var lbl: Label = Label.new()
	lbl.text = "%s  ×%d" % [item_name, qty]
	lbl.custom_minimum_size = Vector2(0, ROW_HEIGHT)
	return lbl


## Scroll forward one page.
func page_forward() -> void:
	if player == null:
		return
	var max_page: int = ceili(float(player.inventory.size()) / float(MAX_ROWS)) - 1
	page_offset = mini(page_offset + 1, max_page)
	_rebuild_rows()


## Scroll backward one page.
func page_back() -> void:
	page_offset = maxi(page_offset - 1, 0)
	_rebuild_rows()
