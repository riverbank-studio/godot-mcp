extends Node

signal countdown_finished
signal tick(seconds_left: float)

@export var duration: float = 10.0

@onready var _countdown_timer: Timer = $Timer
@onready var _tick_timer: Timer = $TickTimer

func _ready() -> void:
	_countdown_timer.wait_time = duration
	_countdown_timer.one_shot = true
	_countdown_timer.timeout.connect(_on_timeout)

	_tick_timer.wait_time = 1.0
	_tick_timer.one_shot = false
	_tick_timer.timeout.connect(_on_tick)

func start_timer() -> void:
	_countdown_timer.start()
	_tick_timer.start()

func _on_timeout() -> void:
	_tick_timer.stop()
	countdown_finished.emit()

func _on_tick() -> void:
	tick.emit(_countdown_timer.time_left)
