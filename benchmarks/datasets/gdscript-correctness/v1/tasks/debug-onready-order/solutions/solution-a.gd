extends Control

@onready var _label: Label = $ScoreLabel

func _ready() -> void:
	_label.text = "Score: 0"

func update_score(score: int) -> void:
	_label.text = "Score: %d" % score
