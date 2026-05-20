extends Control

@onready var _label: Label = $ScoreLabel

func _init() -> void:
	# bug: @onready vars are null during _init, only available in _ready
	_label.text = "Score: 0"

func update_score(score: int) -> void:
	_label.text = "Score: %d" % score
